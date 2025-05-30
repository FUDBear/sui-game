import { createCanvas, registerFont } from 'canvas';
import fs from 'fs';
import path, { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_PATH = resolve(__dirname, '../fonts/Girassol-Regular.ttf');
registerFont(FONT_PATH, { family: 'Girassol' });

const TITLE_FONT_PATH = resolve(__dirname, '../fonts/NewRocker-Regular.ttf');
registerFont(TITLE_FONT_PATH, { family: 'NewRocker' });

const OUT_DIR = './out';
const WIDTH = 512;
const HEIGHT = 256;
const FONT_SIZE = 72;
const COLOR = 'white';
const BG_COLOR = 'black';

function renderLabelPng(text, fileName) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');
  
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
    const TITLE_FONT_SIZE = 96;
    ctx.font = `${TITLE_FONT_SIZE}px "NewRocker"`;
    ctx.fillStyle = COLOR;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Fish Name', WIDTH / 2, 40);
  
    ctx.font = `${FONT_SIZE}px "Girassol"`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, WIDTH / 2, HEIGHT - 40);
  
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(OUT_DIR, fileName), buffer);
    console.log(`✅ Generated: ${fileName}`);
  }
  

  function generateWeightLabels(start = 0.1, end = 50.0, step = 0.1) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
  
    const numSteps = Math.round((end - start) / step);
  
    for (let i = 0; i <= numSteps; i++) {
      const val = (start + i * step).toFixed(1);
      const label = `${val} lbs`;
      const fileName = `weight_${val.replace('.', '_')}.png`;
      renderLabelPng(label, fileName);
    }
  }

generateWeightLabels(0.1, 5.0, 0.1);
