import path from 'path';
import fs from 'fs';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SESSIONS_DIR = path.join(__dirname, 'sessions');
export const TEMP_DIR = path.join(__dirname, 'temp');

const COMMAND_PREFIX = '.';
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const TEMP_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // sweep every 15 minutes

// Recorded once when this module is first loaded (process start), and shared
// by every session/command — used by .ping to report uptime.
export const startTime = Date.now();

// Shared command handler: one registry, used by every session's socket.
const commandRegistry = {
  ping: pingCommand,
  ig: instagramCommand,
  instagram: instagramCommand,
  setcookie: setcookieCommand,
  clearcookie: clearcookieCommand,
};

/**
 * Create sessions/ and temp/ if they don't already exist.
 */
export function ensureDirectories() {
  for (const dir of [SESSIONS_DIR, TEMP_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Format a millisecond duration as "1d 5h 21m 14s".
 */
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

/**
 * Compare a sender JID against the configured owner number.
 * Both sides are normalized to digits-only before comparison, so the
 * format in settings.js ("no + and no spaces") is enforced automatically.
 */
export function isOwner(senderJid, ownerNumber) {
  if (!senderJid || !ownerNumber) return false;
  const senderDigits = senderJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  const ownerDigits = String(ownerNumber).replace(/\D/g, '');
  return senderDigits.length > 0 && senderDigits === ownerDigits;
}

/**
 * Periodically delete anything in temp/ older than one hour. Safety net for
 * any file a command failed to clean up immediately after sending.
 */
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

/**
 * Pull the plain text body (or caption) out of a WA message, regardless of
 * which message type carries it.
 */
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

/**
 * The real sender of a message — the participant JID in groups, otherwise
 * the chat JID itself.
 */
function getSenderJid(msg) {
  return msg.key.participant || msg.key.remoteJid;
}

/**
 * Parse ".command rest of text" into { commandName, args }.
 */
function parseCommand(text) {
  const withoutPrefix = text.slice(COMMAND_PREFIX.length);
  const firstSpace = withoutPrefix.indexOf(' ');
  const commandName = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace))
    .toLowerCase()
    .trim();
  const args = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace + 1).trim();
  return { commandName, args };
}

async function handleIncomingMessage(sock, msg, sessionId) {
  if (!msg.message) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const text = extractText(msg.message).trim();
  if (!text.startsWith(COMMAND_PREFIX)) return;

  const { commandName, args } = parseCommand(text);
  const command = commandRegistry[commandName];
  if (!command) return;

  const ctx = {
    settings,
    isOwner,
    formatUptime,
    startTime,
    senderJid: getSenderJid(msg),
    tempDir: TEMP_DIR,
    sessionId,
  };

  await command(sock, msg, args, ctx);
}

/**
 * Attach the shared message handler to a connected socket. Per-message
 * errors are caught and logged so one bad message never kills the session.
 */
function registerMessageHandler(sock, sessionId) {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      handleIncomingMessage(sock, msg, sessionId).catch((err) => {
        console.error(chalk.red(`[${sessionId}] message handler error:`), err?.message || err);
      });
    }
  });
}

/**
 * Start (or restart, on reconnect) a single WhatsApp session from its
 * sessions/<sessionId>/ auth folder. Never generates or prints a QR code —
 * the folder must already contain valid Baileys credentials.
 */
export async function startSession(sessionId) {
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

  registerMessageHandler(sock, sessionId);

  return sock;
}
