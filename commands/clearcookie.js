import fs from 'fs/promises';

export default async function clearcookie(sock, msg, args, ctx) {
  const jid = msg.key.remoteJid;
  const cookiesPath = ctx.settings.cookiesPath;

  try {
    await fs.unlink(cookiesPath);
    await sock.sendMessage(jid, { text: '🧹 Cookies cleared.' }, { quoted: msg });
  } catch (err) {
    if (err.code === 'ENOENT') {
      await sock.sendMessage(jid, { text: '🍃 No cookies found.' }, { quoted: msg });
      return;
    }

    console.error('clearcookie error:', err);
    await sock.sendMessage(jid, { text: '❌ Could not clear cookies.' }, { quoted: msg });
  }
}
