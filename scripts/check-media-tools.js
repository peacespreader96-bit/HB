import { ensureMediaToolBinaries } from '../utils/mediaTools.js';

const tools = ensureMediaToolBinaries({ installIfMissing: false });

console.log('[media-tools] yt-dlp:', tools.ytdlpLocal ? tools.ytdlpPath : 'PATH fallback');
console.log('[media-tools] ffmpeg:', tools.ffmpegLocal ? tools.ffmpegPath : 'PATH fallback');
console.log('[media-tools] done');
