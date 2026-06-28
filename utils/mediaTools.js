import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');

function fileExists(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableOnPath(commandName) {
  const pathValue = process.env.PATH || '';
  const folders = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];

  for (const folder of folders) {
    for (const ext of extensions) {
      const candidate = path.join(folder, `${commandName}${ext}`);
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}

function resolvePackageRoot(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {}

  try {
    let folder = path.dirname(require.resolve(packageName));

    while (folder && folder !== path.dirname(folder)) {
      const packageJson = path.join(folder, 'package.json');
      if (fileExists(packageJson)) return folder;
      folder = path.dirname(folder);
    }
  } catch {}

  return null;
}

function resolveFfmpegStaticPath() {
  try {
    const ffmpegPath = require('ffmpeg-static');
    return fileExists(ffmpegPath) ? ffmpegPath : null;
  } catch {
    return null;
  }
}

function nodeModulesBinCandidates(binaryName) {
  const win = process.platform === 'win32';
  const names = win
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName]
    : [binaryName];

  const binFolders = [
    path.join(APP_ROOT, 'node_modules', '.bin'),
    path.join(process.cwd(), 'node_modules', '.bin'),
  ];

  return binFolders.flatMap((folder) => names.map((name) => path.join(folder, name)));
}

function markExecutable(filePath) {
  if (!fileExists(filePath) || process.platform === 'win32') return;

  try {
    fs.chmodSync(filePath, 0o755);
  } catch {}
}

export function resolveYtDlpPath() {
  if (fileExists(process.env.YTDLP_PATH)) return process.env.YTDLP_PATH;

  const youtubeDlExecRoot = resolvePackageRoot('youtube-dl-exec');
  const packageCandidates = youtubeDlExecRoot
    ? [
        path.join(youtubeDlExecRoot, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
        path.join(youtubeDlExecRoot, 'bin', 'yt-dlp'),
        path.join(youtubeDlExecRoot, 'bin', process.platform === 'win32' ? 'youtube-dl.exe' : 'youtube-dl'),
        path.join(youtubeDlExecRoot, 'bin', 'youtube-dl'),
      ]
    : [];

  const candidates = [
    ...nodeModulesBinCandidates('yt-dlp'),
    ...nodeModulesBinCandidates('youtube-dl'),
    ...packageCandidates,
  ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      markExecutable(candidate);
      return candidate;
    }
  }

  return isExecutableOnPath('yt-dlp') || isExecutableOnPath('youtube-dl') || 'yt-dlp';
}

export function resolveFfmpegPath() {
  if (fileExists(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;

  const ffmpegPath = resolveFfmpegStaticPath() || isExecutableOnPath('ffmpeg') || 'ffmpeg';
  markExecutable(ffmpegPath);
  return ffmpegPath;
}

export function getMediaToolStatus() {
  const ytdlpPath = resolveYtDlpPath();
  const ffmpegPath = resolveFfmpegPath();

  return {
    ytdlpPath,
    ffmpegPath,
    ytdlpLocal: fileExists(ytdlpPath),
    ffmpegLocal: fileExists(ffmpegPath),
  };
}

export function ensureMediaToolBinaries({ installIfMissing = false, log = false } = {}) {
  let tools = getMediaToolStatus();

  if (installIfMissing && (!tools.ytdlpLocal || !tools.ffmpegLocal)) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    if (log) console.log('[media-tools] installing/repairing yt-dlp + ffmpeg...');

    execFileSync(
      npmCommand,
      ['install', 'youtube-dl-exec@latest', 'ffmpeg-static@latest', '--no-audit', '--no-fund', '--yes'],
      {
        cwd: APP_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_yes: 'true',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
        },
      },
    );

    tools = getMediaToolStatus();
  }

  markExecutable(tools.ytdlpPath);
  markExecutable(tools.ffmpegPath);

  return tools;
}
