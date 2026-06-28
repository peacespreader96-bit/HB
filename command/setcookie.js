import fs from 'fs/promises';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

export default async function setcookie(sock, msg, args, ctx) {
  const jid = msg.key.remoteJid;
  const cookiesPath = ctx.settings.cookiesPath;
  const documentMessage = msg.message?.documentMessage;

  try {
    if (documentMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer || buffer.length === 0) throw new Error('Empty cookies file.');
      await fs.writeFile(cookiesPath, buffer);
    } else if (args.trim().length > 0) {
      await fs.writeFile(cookiesPath, `${args.trim()}\n`, 'utf-8');
    } else {
      await sock.sendMessage(jid, { text: '🍪 Send cookies.txt with caption .setcookie.' }, { quoted: msg });
      return;
    }

    await sock.sendMessage(jid, { text: '✅ Cookies saved.' }, { quoted: msg });
  } catch (err) {
    console.error('setcookie error:', err);
    await sock.sendMessage(jid, { text: '❌ Could not save cookies.' }, { quoted: msg });
  }
}
