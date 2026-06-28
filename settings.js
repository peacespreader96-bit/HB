import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIES_PATH = './cookies.txt';

export default {
  botName: 'Hannan Mariyam Bot',
  ownerNumber: '916360814849',
  cookiesPath: path.isAbsolute(COOKIES_PATH) ? COOKIES_PATH : path.join(__dirname, COOKIES_PATH),

  deliveryCaptions: [
    '💌 My love Hannan Mariyam My Wife',
    '✨ My love Hannan Mariyam My Wife',
    '🌙 My love Hannan Mariyam My Wife',
    '🫶 My love Hannan Mariyam My Wife',
    '💫 My love Hannan Mariyam My Wife',
    '🥀 My love Hannan Mariyam My Wife',
  ],
};
