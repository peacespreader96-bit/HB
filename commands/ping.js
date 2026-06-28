export default async function ping(sock, msg, args, ctx) {
  const jid = msg.key.remoteJid;
  const start = Date.now();

  const sent = await sock.sendMessage(jid, { text: '🏓 Pong' }, { quoted: msg });
  const latency = Date.now() - start;
  const uptime = ctx.formatUptime(Date.now() - ctx.startTime);

  await sock.sendMessage(jid, {
    text: `🏓 Pong\n⚡ ${latency}ms\n⏱ ${uptime}`,
    edit: sent.key,
  });
}
