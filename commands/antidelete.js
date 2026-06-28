import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile } from 'fs/promises';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// Own dirs — kept separate from main.js's TEMP_DIR so the 1hr temp-sweep
// job in main.js can never delete a captured message's media before a
// deletion event for it arrives.
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ANTIDELETE_TMP_DIR = path.join(PROJECT_ROOT, 'tmp', 'antidelete');

for (const dir of [DATA_DIR, ANTIDELETE_TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// One in-memory store, shared by every session process-wide. Keys are
// namespaced "sessionId:messageId" so multiple WA accounts never clash.
const messageStore = new Map();
const MAX_STORE_SIZE = 500;

function pruneStoreIfNeeded() {
  if (messageStore.size <= MAX_STORE_SIZE) return;
  const oldestKey = messageStore.keys().next().value;
  const oldest = messageStore.get(oldestKey);
  if (oldest?.mediaPath) {
    try { fs.unlinkSync(oldest.mediaPath); } catch {}
  }
  messageStore.delete(oldestKey);
}

// ── PER-SESSION CONFIG ───────────────────────────────────────────────────
function safeSessionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function configPath(sessionId) {
  return path.join(DATA_DIR, `antidelete-${safeSessionId(sessionId)}.json`);
}

function loadAntideleteConfig(sessionId) {
  try {
    const p = configPath(sessionId);
    if (!fs.existsSync(p)) return { enabled: false };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { enabled: false };
  }
}

function saveAntideleteConfig(sessionId, config) {
  try {
    fs.writeFileSync(configPath(sessionId), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[antidelete] config save error:', err);
  }
}

// ── TEMP MEDIA CLEANUP (size-capped, not age-capped) ────────────────────
function getFolderSizeInMB(folderPath) {
  try {
    return fs.readdirSync(folderPath).reduce((total, file) => {
      const fp = path.join(folderPath, file);
      return total + (fs.statSync(fp).isFile() ? fs.statSync(fp).size : 0);
    }, 0) / (1024 * 1024);
  } catch {
    return 0;
  }
}

function cleanTempFolderIfLarge() {
  try {
    if (getFolderSizeInMB(ANTIDELETE_TMP_DIR) > 200) {
      fs.readdirSync(ANTIDELETE_TMP_DIR).forEach((file) => {
        try { fs.unlinkSync(path.join(ANTIDELETE_TMP_DIR, file)); } catch {}
      });
    }
  } catch (err) {
    console.error('[antidelete] temp cleanup error:', err);
  }
}
setInterval(cleanTempFolderIfLarge, 60_000);

// ── MEDIA DOWNLOAD (bug fixed: stream collected to Buffer before write) ──
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadMedia(messageContent, type, sessionId, messageId, ext) {
  const stream = await downloadContentFromMessage(messageContent, type);
  const buffer = await streamToBuffer(stream);
  const mediaPath = path.join(
    ANTIDELETE_TMP_DIR,
    `${safeSessionId(sessionId)}_${messageId}.${ext}`,
  );
  await writeFile(mediaPath, buffer);
  return mediaPath;
}

function ownerJidFor(sock) {
  return sock.user.id.split(':')[0] + '@s.whatsapp.net';
}

// ════════════════════════════════════════════════════════════════════════
// CAPTURE — call on every incoming message, before command routing.
// ════════════════════════════════════════════════════════════════════════
export async function storeMessage(sock, msg, ctx) {
  try {
    const config = loadAntideleteConfig(ctx.sessionId);
    if (!config.enabled) return;
    if (!msg.key?.id) return;

    const messageId = msg.key.id;
    const storeKey = `${ctx.sessionId}:${messageId}`;
    const sender = msg.key.participant || msg.key.remoteJid;

    let content = '';
    let mediaType = '';
    let mediaPath = '';
    let isViewOnce = false;

    const viewOnceContainer =
      msg.message?.viewOnceMessageV2?.message ||
      msg.message?.viewOnceMessage?.message;

    if (viewOnceContainer) {
      if (viewOnceContainer.imageMessage) {
        content = viewOnceContainer.imageMessage.caption || '';
        mediaPath = await downloadMedia(viewOnceContainer.imageMessage, 'image', ctx.sessionId, messageId, 'jpg');
        mediaType = 'image';
        isViewOnce = true;
      } else if (viewOnceContainer.videoMessage) {
        content = viewOnceContainer.videoMessage.caption || '';
        mediaPath = await downloadMedia(viewOnceContainer.videoMessage, 'video', ctx.sessionId, messageId, 'mp4');
        mediaType = 'video';
        isViewOnce = true;
      }
    } else if (msg.message?.conversation) {
      content = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
      content = msg.message.extendedTextMessage.text;
    } else if (msg.message?.imageMessage) {
      content = msg.message.imageMessage.caption || '';
      mediaPath = await downloadMedia(msg.message.imageMessage, 'image', ctx.sessionId, messageId, 'jpg');
      mediaType = 'image';
    } else if (msg.message?.stickerMessage) {
      mediaPath = await downloadMedia(msg.message.stickerMessage, 'sticker', ctx.sessionId, messageId, 'webp');
      mediaType = 'sticker';
    } else if (msg.message?.videoMessage) {
      content = msg.message.videoMessage.caption || '';
      mediaPath = await downloadMedia(msg.message.videoMessage, 'video', ctx.sessionId, messageId, 'mp4');
      mediaType = 'video';
    } else if (msg.message?.audioMessage) {
      const mime = msg.message.audioMessage.mimetype || '';
      const ext = mime.includes('ogg') ? 'ogg' : 'mp3';
      mediaPath = await downloadMedia(msg.message.audioMessage, 'audio', ctx.sessionId, messageId, ext);
      mediaType = 'audio';
    }
    // documents intentionally skipped — too large, not useful here

    messageStore.set(storeKey, {
      content,
      mediaType,
      mediaPath,
      sender,
      group: msg.key.remoteJid?.endsWith('@g.us') ? msg.key.remoteJid : null,
      timestamp: new Date().toISOString(),
    });
    pruneStoreIfNeeded();

    // Anti-view-once side effect: forward instantly to this session's owner
    if (isViewOnce && mediaType && fs.existsSync(mediaPath)) {
      try {
        const ownerJid = ownerJidFor(sock);
        const senderTag = sender.split('@')[0];
        const opts = {
          caption: `*Anti-ViewOnce ${mediaType}*\nFrom: @${senderTag}`,
          mentions: [sender],
        };
        if (mediaType === 'image') {
          await sock.sendMessage(ownerJid, { image: { url: mediaPath }, ...opts });
        } else if (mediaType === 'video') {
          await sock.sendMessage(ownerJid, { video: { url: mediaPath }, ...opts });
        }
        try { fs.unlinkSync(mediaPath); } catch {}
      } catch {}
    }
  } catch (err) {
    console.error('[antidelete] storeMessage error:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════
// DETECT — call when msg.message?.protocolMessage?.type === 0.
// ════════════════════════════════════════════════════════════════════════
export async function handleMessageRevocation(sock, msg, ctx) {
  try {
    const config = loadAntideleteConfig(ctx.sessionId);
    if (!config.enabled) return;

    const messageId = msg.message?.protocolMessage?.key?.id;
    if (!messageId) return;
    const storeKey = `${ctx.sessionId}:${messageId}`;

    const deletedBy = msg.participant || msg.key?.participant || msg.key?.remoteJid;
    const ownerJid = ownerJidFor(sock);

    // Don't notify if the bot/owner deleted their own message
    if (!deletedBy || deletedBy.includes(sock.user.id) || deletedBy === ownerJid) return;

    const original = messageStore.get(storeKey);
    if (!original) return; // not stored — bot was offline or antidelete was off

    const sender = original.sender;
    const senderName = sender.split('@')[0];
    const groupName = original.group
      ? (await sock.groupMetadata(original.group).catch(() => ({ subject: 'Unknown' }))).subject
      : null;

    const time = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour12: true,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      day: '2-digit', month: '2-digit', year: 'numeric',
    });

    let report =
      `*🔰 ANTIDELETE REPORT 🔰*\n\n` +
      `*🗑️ Deleted By:* @${deletedBy.split('@')[0]}\n` +
      `*👤 Sender:* @${senderName}\n` +
      `*📱 Number:* ${sender}\n` +
      `*🕒 Time:* ${time}\n`;

    if (groupName) report += `*👥 Group:* ${groupName}\n`;
    if (original.content) report += `\n*💬 Deleted Message:*\n${original.content}`;

    await sock.sendMessage(ownerJid, { text: report, mentions: [deletedBy, sender] });

    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
      const mediaCaption = {
        caption: `*Deleted ${original.mediaType}*\nFrom: @${senderName}`,
        mentions: [sender],
      };
      try {
        switch (original.mediaType) {
          case 'image':
            await sock.sendMessage(ownerJid, { image: { url: original.mediaPath }, ...mediaCaption });
            break;
          case 'sticker':
            await sock.sendMessage(ownerJid, { sticker: { url: original.mediaPath } });
            break;
          case 'video':
            await sock.sendMessage(ownerJid, { video: { url: original.mediaPath }, ...mediaCaption });
            break;
          case 'audio':
            await sock.sendMessage(ownerJid, {
              audio: { url: original.mediaPath },
              mimetype: 'audio/mpeg',
              ptt: false,
              ...mediaCaption,
            });
            break;
        }
      } catch (err) {
        await sock.sendMessage(ownerJid, { text: `⚠️ Could not send deleted media: ${err.message}` });
      }
      try { fs.unlinkSync(original.mediaPath); } catch {}
    }

    messageStore.delete(storeKey);
  } catch (err) {
    console.error('[antidelete] handleMessageRevocation error:', err);
  }
}

// ════════════════════════════════════════════════════════════════════════
// COMMAND — .antidelete on/off. Owner-only. Matches your command signature.
// ════════════════════════════════════════════════════════════════════════
export default async function antidelete(sock, msg, args, ctx) {
  const jid = msg.key.remoteJid;
  const allowed = msg.key.fromMe || ctx.isOwner(ctx.senderJid, ctx.settings.ownerNumber);

  if (!allowed) {
    await sock.sendMessage(jid, { text: '*Only the bot owner can use this command.*' }, { quoted: msg });
    return;
  }

  const config = loadAntideleteConfig(ctx.sessionId);
  const match = args.trim().toLowerCase();

  if (!match) {
    await sock.sendMessage(jid, {
      text:
        `*ANTIDELETE SETUP*\n\n` +
        `Current Status: ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
        `*.antidelete on*  — Enable\n` +
        `*.antidelete off* — Disable`,
    }, { quoted: msg });
    return;
  }

  if (match === 'on') config.enabled = true;
  else if (match === 'off') config.enabled = false;
  else {
    await sock.sendMessage(jid, { text: '*Invalid option. Use .antidelete on or .antidelete off*' }, { quoted: msg });
    return;
  }

  saveAntideleteConfig(ctx.sessionId, config);
  await sock.sendMessage(jid, {
    text: `*Antidelete ${match === 'on' ? 'enabled ✅' : 'disabled ❌'}*`,
  }, { quoted: msg });
}
