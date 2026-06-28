import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { ensureMediaToolBinaries, getMediaToolStatus } from '../utils/mediaTools.js';

const require = createRequire(import.meta.url);
const requiredPackages = [
  '@whiskeysockets/baileys',
  '@hapi/boom',
  'chalk',
  'pino',
  'ffmpeg-static',
  'youtube-dl-exec',
];

function hasPackage(packageName) {
  try {
    require.resolve(`${packageName}/package.json`);
    return true;
  } catch {
    try {
      require.resolve(packageName);
      return true;
    } catch {
      return false;
    }
  }
}

const missing = requiredPackages.filter((packageName) => !hasPackage(packageName));

if (missing.length > 0) {
  console.log(`[setup] installing missing packages: ${missing.join(', ')}`);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  execFileSync(npmCommand, ['install', '--no-audit', '--no-fund', '--yes'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_yes: 'true',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
}

const tools = ensureMediaToolBinaries({ installIfMissing: true, log: true });

console.log('[setup] dependencies ready');
console.log('[setup] yt-dlp:', tools.ytdlpLocal ? tools.ytdlpPath : 'PATH fallback');
console.log('[setup] ffmpeg:', tools.ffmpegLocal ? tools.ffmpegPath : 'PATH fallback');
