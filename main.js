import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import chalk from 'chalk';

import settings from './settings.js';
import pingCommand from './commands/ping.js';
import instagramCommand from './commands/instagram.js';
import setcookieCommand from './commands/setcookie.js';
import clearcookieCommand from './commands/clearcookie.js';
import antideleteCommand, {
  storeMessage as storeMessageForAntidelete,
  handleMessageRevocation as handleAntideleteRevocation,
} from './commands/antidelete.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SESSIONS_DIR = path.join(__dirname, 'sessions');
export const TEMP_DIR = path.join(__dirname, 'temp');
export const DATA_DIR = path.join(__dirname, 'data');
export const COMMAND_LOCK_DIR = path.join(DATA_DIR, 'command-locks');

const COMMAND_PREFIX = '.';
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
const TEMP_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

// Important:
// Any command older than this bot socket startup will be ignored.
// This stops old .ig messages from running again after reconnect/history sync.
const STARTUP_GRACE_MS = 15 * 1000;

// Keep command lock files for 24 hours.
const COMMAND_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const startTime = Date.now();

const commandRegistry = {
  ping: pingCommand,
  ig: instagramCommand,
  instagram: instagramCommand,
  setcookie: setcookieCommand,
  clearcookie: clearcookieCommand,
  antidelete: antideleteCommand,
};

export function ensureDirectories() {
  for (const dir of [SESSIONS_DIR, TEMP_DIR, DATA_DIR, COMMAND_LOCK_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function formatUptime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

export function isOwner(senderJid, ownerNumber) {
  if (!senderJid || !ownerNumber) return false;
  const senderDigits = senderJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  const ownerDigits = String(ownerNumber).replace(/\D/g, '');
  return senderDigits.length > 0 && senderDigits === ownerDigits;
}

export function startTempCleanupJob() {
  const sweep = () => {
    fs.readdir(TEMP_DIR, (err, files) => {
      if (err) return;

      const now = Date.now();

      for (const file of files) {
        if (file === '.gitkeep') continue;

        const filePath = path.join(TEMP_DIR, file);

        fs.stat(filePath, (statErr, stats) => {
          if (statErr || !stats.isFile()) return;

          if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
            fs.unlink(filePath, () => {});
          }
        });
      }
    });
  };

  sweep();
  setInterval(sweep, TEMP_CLEANUP_INTERVAL_MS);
}

function extractText(message) {
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

function getSenderJid(msg) {
  return msg.key.participant || msg.key.remoteJid;
}

function parseCommand(text) {
  const withoutPrefix = text.slice(COMMAND_PREFIX.length);
  const firstSpace = withoutPrefix.indexOf(' ');

  const commandName = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace))
    .toLowerCase()
    .trim();

  const args = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace + 1).trim();

  return { commandName, args };
}

function longObjectToNumber(value) {
  const low = value.low >>> 0;
  const high = value.high >>> 0;
  return high * 0x100000000 + low;
}

function getMessageTimestampMs(msg) {
  const ts = msg.messageTimestamp;
  if (!ts) return 0;

  let raw = 0;

  if (typeof ts === 'number') {
    raw = ts;
  } else if (typeof ts === 'bigint') {
    raw = Number(ts);
  } else if (typeof ts?.toNumber === 'function') {
    raw = ts.toNumber();
  } else if (typeof ts?.low === 'number' && typeof ts?.high === 'number') {
    raw = longObjectToNumber(ts);
  } else {
    raw = Number(ts);
  }

  if (!Number.isFinite(raw) || raw <= 0) return 0;

  // WhatsApp usually gives seconds. If it already looks like ms, keep it.
  return raw > 1_000_000_000_000 ? raw : raw * 1000;
}

function isCommandFromBeforeSocketStart(msg, socketStartedAt) {
  const timestampMs = getMessageTimestampMs(msg);
  if (!timestampMs) return false;

  return timestampMs < socketStartedAt - STARTUP_GRACE_MS;
}

function cleanupOldCommandLocks() {
  try {
    if (!fs.existsSync(COMMAND_LOCK_DIR)) {
      fs.mkdirSync(COMMAND_LOCK_DIR, { recursive: true });
      return;
    }

    const now = Date.now();

    for (const file of fs.readdirSync(COMMAND_LOCK_DIR)) {
      const filePath = path.join(COMMAND_LOCK_DIR, file);
      const stats = fs.statSync(filePath);

      if (!stats.isFile()) continue;

      if (now - stats.mtimeMs > COMMAND_LOCK_MAX_AGE_MS) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    }
  } catch (err) {
    console.error(chalk.red('[command-lock] cleanup error:'), err?.message || err);
  }
}

function makeCommandLockKey(msg, sessionId, commandName, args) {
  const messageId = msg.key?.id || '';
  const chat = msg.key?.remoteJid || '';
  const participant = msg.key?.participant || '';
  const fromMe = msg.key?.fromMe ? 'fromMe' : 'notFromMe';

  const raw = `${sessionId}|${chat}|${participant}|${fromMe}|${messageId}|${commandName}|${args}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function tryAcquireCommandLock(msg, sessionId, commandName, args) {
  try {
    if (!fs.existsSync(COMMAND_LOCK_DIR)) {
      fs.mkdirSync(COMMAND_LOCK_DIR, { recursive: true });
    }

    cleanupOldCommandLocks();

    const lockKey = makeCommandLockKey(msg, sessionId, commandName, args);
    const lockPath = path.join(COMMAND_LOCK_DIR, `${lockKey}.lock`);

    fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;

    console.error(chalk.red('[command-lock] error:'), err?.message || err);
    return true;
  }
}

async function handleIncomingMessage(sock, msg, sessionId, socketStartedAt) {
  if (!msg.message) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const ctx = {
    settings,
    isOwner,
    formatUptime,
    startTime,
    senderJid: getSenderJid(msg),
    tempDir: TEMP_DIR,
    sessionId,
  };

  storeMessageForAntidelete(sock, msg, ctx).catch((err) => {
    console.error(chalk.red(`[${sessionId}] antidelete store error:`), err?.message || err);
  });

  if (msg.message?.protocolMessage?.type === 0) {
    await handleAntideleteRevocation(sock, msg, ctx);
    return;
  }

  const text = extractText(msg.message).trim();
  if (!text.startsWith(COMMAND_PREFIX)) return;

  const { commandName, args } = parseCommand(text);
  const command = commandRegistry[commandName];
  if (!command) return;

  if (isCommandFromBeforeSocketStart(msg, socketStartedAt)) {
    console.log(chalk.gray(`[${sessionId}] skipped old replayed command: ${text.slice(0, 80)}`));
    return;
  }

  if (!tryAcquireCommandLock(msg, sessionId, commandName, args)) {
    console.log(chalk.gray(`[${sessionId}] skipped locked duplicate command: ${text.slice(0, 80)}`));
    return;
  }

  console.log(chalk.cyan(`[${sessionId}] running command: ${text.slice(0, 80)}`));
  await command(sock, msg, args, ctx);
}

function registerMessageHandler(sock, sessionId, socketStartedAt) {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      handleIncomingMessage(sock, msg, sessionId, socketStartedAt).catch((err) => {
        console.error(chalk.red(`[${sessionId}] message handler error:`), err?.message || err);
      });
    }
  });
}

export async function startSession(sessionId) {
  const socketStartedAt = Date.now();
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(chalk.greenBright(`[${sessionId}] online.`));
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log(chalk.yellow(`[${sessionId}] session logged out. Not reconnecting.`));
        return;
      }

      console.log(chalk.yellow(`[${sessionId}] reconnecting...`));

      startSession(sessionId).catch((err) => {
        console.error(chalk.red(`[${sessionId}] reconnect failed:`), err?.message || err);
      });
    }
  });

  registerMessageHandler(sock, sessionId, socketStartedAt);

  return sock;
}
