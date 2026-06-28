import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

import { startSession, ensureDirectories, startTempCleanupJob, SESSIONS_DIR } from './main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printBanner() {
  console.log('');
  console.log(chalk.magentaBright.bold('  ╔══════════════════════════════════════╗'));
  console.log(chalk.magentaBright.bold('  ║        ') + chalk.cyanBright.bold('Hannan Mariyam Bot') + chalk.magentaBright.bold('        ║'));
  console.log(chalk.magentaBright.bold('  ║   ') + chalk.yellowBright('Made with love by Afroz Khan') + chalk.magentaBright.bold('   ║'));
  console.log(chalk.magentaBright.bold('  ╚══════════════════════════════════════╝'));
  console.log('');
}

function getSessionFolders() {
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function main() {
  printBanner();
  ensureDirectories();
  startTempCleanupJob();

  const sessionFolders = getSessionFolders();

  if (sessionFolders.length === 0) {
    console.log(chalk.redBright('No sessions found in sessions/.'));
    return;
  }

  for (const sessionId of sessionFolders) {
    startSession(sessionId).catch((err) => {
      console.error(chalk.red(`Failed to start "${sessionId}":`), err?.message || err);
    });
  }
}

process.on('unhandledRejection', (err) => {
  console.error(chalk.red('Unhandled rejection:'), err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error(chalk.red('Uncaught exception:'), err?.message || err);
});

main().catch((err) => {
  console.error(chalk.red('Startup failed:'), err?.message || err);
  process.exit(1);
});
