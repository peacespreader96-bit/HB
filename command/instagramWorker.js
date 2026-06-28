import { execFile } from 'child_process';
import { promisify } from 'util';
import fsp from 'fs/promises';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { resolveYtDlpPath, resolveFfmpegPath } from '../utils/mediaTools.js';

const execFileAsync = promisify(execFile);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function listRequestFiles(tempDir, requestId) {
  const files = await fsp.readdir(tempDir).catch(() => []);

  return files
    .filter((name) => name.startsWith(`${requestId}_`))
    .filter((name) => !/\.(part|ytdl|tmp|json|description)$/i.test(name))
    .sort()
    .map((name) => path.join(tempDir, name));
}

function looksLikeNetscapeCookies(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => /^# Netscape HTTP Cookie File/i.test(line))) return true;

  return lines.some((line) => {
    if (line.startsWith('#')) return false;
    const columns = line.split('\t');
    return columns.length >= 7 && columns[0].includes('instagram') && columns[5] && columns[6];
  });
}

function cookieJsonToHeader(text) {
  try {
    const parsed = JSON.parse(text);
    const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(cookies)) return null;

    const pairs = cookies
      .filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value !== 'undefined')
      .filter((cookie) => !cookie.domain || String(cookie.domain).includes('instagram'))
      .map((cookie) => `${cookie.name}=${cookie.value}`);

    return pairs.length > 0 ? pairs.join('; ') : null;
  } catch {
    return null;
  }
}

function rawCookieTextToHeader(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const jsonHeader = cookieJsonToHeader(trimmed);
  if (jsonHeader) return jsonHeader;

  return trimmed
    .replace(/^cookie\s*:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .join('; ')
    .replace(/;\s*;/g, ';')
    .trim();
}

async function buildCookieArgs(cookiesPath) {
  const text = await fsp.readFile(cookiesPath, 'utf-8').catch(() => '');
  if (!text.trim()) return [];

  if (looksLikeNetscapeCookies(text)) {
    return ['--cookies', cookiesPath];
  }

  const cookieHeader = rawCookieTextToHeader(text);
  return cookieHeader ? ['--add-header', `Cookie: ${cookieHeader}`] : [];
}

function sanitizeError(text) {
  return String(text || '')
    .replace(/sessionid=[^;\s]+/gi, 'sessionid=***')
    .replace(/csrftoken=[^;\s]+/gi, 'csrftoken=***')
    .replace(/ds_user_id=[^;\s]+/gi, 'ds_user_id=***')
    .replace(/mid=[^;\s]+/gi, 'mid=***')
    .slice(-1800);
}

function summarizeError(stderr, message) {
  const text = sanitizeError(`${stderr || ''}\n${message || ''}`);

  if (/login required|please login|cookies/i.test(text)) return 'Cookies expired or wrong format.';
  if (/private|not available|unable to extract|permission/i.test(text)) return 'Private/unavailable media.';
  if (/unsupported url|no suitable extractor/i.test(text)) return 'Unsupported link.';
  if (/ffmpeg/i.test(text)) return 'ffmpeg issue.';
  if (/yt-dlp|youtube-dl|ENOENT|not found/i.test(text)) return 'yt-dlp issue.';
  if (/timed out|timeout/i.test(text)) return 'Timed out.';

  return 'Download failed.';
}

async function run() {
  const {
    url,
    cookiesPath,
    tempDir,
    requestId,
    downloadTimeoutMs,
    maxBufferBytes,
    ytdlpPath,
    ffmpegPath,
  } = workerData;

  await fsp.mkdir(tempDir, { recursive: true });

  const outputTemplate = path.join(tempDir, `${requestId}_%(id)s_%(autonumber)s.%(ext)s`);
  const finalYtDlpPath = ytdlpPath || resolveYtDlpPath();
  const finalFfmpegPath = ffmpegPath || resolveFfmpegPath();
  const cookieArgs = await buildCookieArgs(cookiesPath);

  const args = [
    '--ignore-config',
    '--no-warnings',
    '--user-agent', USER_AGENT,
    '--referer', 'https://www.instagram.com/',
    ...cookieArgs,
    '--no-playlist',
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    ...(finalFfmpegPath ? ['--ffmpeg-location', finalFfmpegPath] : []),
    '--output', outputTemplate,
    url,
  ];

  try {
    await execFileAsync(finalYtDlpPath || 'yt-dlp', args, {
      timeout: downloadTimeoutMs,
      maxBuffer: maxBufferBytes,
      windowsHide: true,
    });

    parentPort.postMessage({
      ok: true,
      files: await listRequestFiles(tempDir, requestId),
    });
  } catch (err) {
    const stderr = sanitizeError(err?.stderr || err?.message || '');

    parentPort.postMessage({
      ok: false,
      message: summarizeError(stderr, err?.message),
      code: err?.code,
      signal: err?.signal,
      killed: err?.killed,
      stderr,
      files: await listRequestFiles(tempDir, requestId),
    });
  }
}

run().catch((err) => {
  parentPort.postMessage({
    ok: false,
    message: sanitizeError(err?.message || 'Worker failed.'),
    stderr: sanitizeError(err?.stack || err?.message || ''),
  });
});
