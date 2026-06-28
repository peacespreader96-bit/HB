import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { ensureMediaToolBinaries } from '../utils/mediaTools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_PATH = path.join(__dirname, 'instagramWorker.js');

const INSTAGRAM_URL_REGEX =
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(\?[A-Za-z0-9=&_%.~-]*)?$/i;

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MAX_MEDIA_ITEMS = 10;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

const FALLBACK_CAPTIONS = [
  '💌 My love Hannan Mariyam My Wife',
  '✨ My love Hannan Mariyam My Wife',
  '🌙 My love Hannan Mariyam My Wife',
  '🫶 My love Hannan Mariyam My Wife',
  '💫 My love Hannan Mariyam My Wife',
];

function randomCaption(settings) {
  const captions = Array.isArray(settings?.deliveryCaptions) && settings.deliveryCaptions.length > 0
    ? settings.deliveryCaptions
    : FALLBACK_CAPTIONS;

  return captions[Math.floor(Math.random() * captions.length)];
}

async function cleanupFiles(filePaths) {
  await Promise.all(filePaths.map((filePath) => fsp.unlink(filePath).catch(() => {})));
}

function runDownloadWorker({ url, cookiesPath, tempDir, requestId }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        url,
        cookiesPath,
        tempDir,
        requestId,
        downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBufferBytes: MAX_BUFFER_BYTES,
        ytdlpPath: ensureMediaToolBinaries({ installIfMissing: false }).ytdlpPath,
        ffmpegPath: ensureMediaToolBinaries({ installIfMissing: false }).ffmpegPath,
      },
    });

    let settled = false;

    worker.once('message', (payload) => {
      settled = true;

      if (payload?.ok) {
        resolve(payload.files || []);
        return;
      }

      const err = new Error(payload?.message || 'Download failed.');
      err.code = payload?.code;
      err.signal = payload?.signal;
      err.killed = payload?.killed;
      err.stderr = payload?.stderr;
      err.files = payload?.files || [];
      reject(err);
    });

    worker.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`Worker stopped with code ${code}.`));
      }
    });
  });
}

export default async function instagram(sock, msg, args, ctx) {
  const jid = msg.key.remoteJid;
  const url = args.trim();
  const tempDir = ctx.tempDir;

  if (!url) {
    await sock.sendMessage(jid, { text: '🔗 Send an Instagram post/reel link.' }, { quoted: msg });
    return;
  }

  if (!INSTAGRAM_URL_REGEX.test(url)) {
    await sock.sendMessage(jid, { text: '❌ Invalid IG link.' }, { quoted: msg });
    return;
  }

  const cookiesPath = ctx.settings.cookiesPath;

  if (!fs.existsSync(cookiesPath)) {
    await sock.sendMessage(jid, { text: '🍪 Cookies missing. Use .setcookie.' }, { quoted: msg });
    return;
  }

  await sock.sendMessage(jid, { text: '✨ Download started…' }, { quoted: msg });

  const requestId = crypto.randomBytes(6).toString('hex');
  let downloadedFiles = [];

  try {
    downloadedFiles = await runDownloadWorker({ url, cookiesPath, tempDir, requestId });
  } catch (err) {
    downloadedFiles = err?.files || [];
    await cleanupFiles(downloadedFiles);

    const stderrText = String(err?.stderr || err?.message || '');
    console.error('[instagram-download]', {
      code: err?.code,
      signal: err?.signal,
      killed: err?.killed,
      reason: err?.message,
      detail: stderrText.slice(-700),
    });

    if (err?.code === 127 || err?.code === 'ENOENT' || /command not found|yt-dlp.*not found|ffmpeg.*not found|ENOENT/i.test(stderrText)) {
      await sock.sendMessage(jid, { text: '⚙️ Tools auto-installing. Restart bot once.' }, { quoted: msg });
      return;
    }

    if (err?.killed || err?.signal === 'SIGTERM') {
      await sock.sendMessage(jid, { text: '⌛ Timed out. Try again.' }, { quoted: msg });
      return;
    }

    const shortReason = err?.message && err.message !== 'Download failed.' ? ` ${err.message}` : '';
    await sock.sendMessage(jid, { text: `❌ Failed.${shortReason}` }, { quoted: msg });
    return;
  }

  if (downloadedFiles.length === 0) {
    await sock.sendMessage(jid, { text: '🥀 No media found.' }, { quoted: msg });
    return;
  }

  const itemsToSend = downloadedFiles.slice(0, MAX_MEDIA_ITEMS);

  try {
    for (const filePath of itemsToSend) {
      const ext = path.extname(filePath).slice(1).toLowerCase();

      try {
        const buffer = await fsp.readFile(filePath);
        const caption = randomCaption(ctx.settings);

        if (VIDEO_EXTENSIONS.has(ext)) {
          await sock.sendMessage(jid, { video: buffer, caption }, { quoted: msg });
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          await sock.sendMessage(jid, { image: buffer, caption }, { quoted: msg });
        }
      } finally {
        await fsp.unlink(filePath).catch(() => {});
      }
    }
  } finally {
    await cleanupFiles(downloadedFiles);
  }
}
