import express from 'express';
import { createCanvas, registerFont } from 'canvas';
import path, { resolve } from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';

const router = express.Router();

const NEW_ROCKER_PATH = resolve('./fonts/NewRocker-Regular.ttf');
registerFont(NEW_ROCKER_PATH, { family: 'NewRocker' });

const GIRASSOL_PATH = resolve('./fonts/Girassol-Regular.ttf');
registerFont(GIRASSOL_PATH, { family: 'Girassol' });

const BASE_BACKGROUND_ID = 'iQ016wrAHx5cyHxHEowd1peIVXv-3TH65HnoYLbRI90';
const PORT = process.env.PORT || 3000;

const EVENT_OVERLAYS = {
  blood:     '9rLdiD5CcSTaD1sfTub2GCInebLlfN8MUEgHFJvfY4I',
  frozen:    'ey5XpjXtfd3rHhO1_uUbYfAxEl6rqwYeVZmeoqqcgMY',
  nightmare: 'WOUk1DaNVzyPfAL26Aox3Eqx3ExUz66NhOSs4rq25R4',
  toxic:     'M0jaDU-eDAjZCNBWykOzN2AGaFSZcr2buGm84PiTFrk'
};

const WATER_OVERLAYS = [
  'fZ-16_bfoiA5Gu3v2t9eFAv-rTr-JTnRhthQXx5mWjk',
  'kady2AExso2decYWImV0ixkQOh6yiXdbbXuYmb4bajY',
  'f_dsdjrOg9E2jkw61TKjEaQOWCDyCYQGU5haaSYdHnE'
];

function sanitizeFilename(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\/\\?%*:|"<>]/g, '')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/\./g, '_');
}

async function generateFishImage({ hash, label = '8.9 lbs • 21 in', fishName = 'Stonefin Gulper', event = '' }) {
  console.log('🎣 Starting generateFishImage with params:', { hash, label, fishName, event });
  
  if (!hash) throw new Error('Missing hash parameter');

  if (Array.isArray(label)) label = label.join(', ');
  if (Array.isArray(fishName)) fishName = fishName.join(' ');
  if (Array.isArray(event)) event = event[0];

  console.log('📥 Fetching fish image from:', `https://walrus.tusky.io/${hash}`);
  const fishResp = await fetch(`https://walrus.tusky.io/${hash}`);
  if (!fishResp.ok) throw new Error(`Fish fetch failed: ${fishResp.status} ${fishResp.statusText}`);
  const fishBuf = Buffer.from(await fishResp.arrayBuffer());
  console.log('✅ Fish image fetched successfully');

  console.log('📥 Fetching base background from:', `https://walrus.tusky.io/${BASE_BACKGROUND_ID}`);
  const baseBgResp = await fetch(`https://walrus.tusky.io/${BASE_BACKGROUND_ID}`);
  if (!baseBgResp.ok) throw new Error(`Base background fetch failed: ${baseBgResp.status} ${baseBgResp.statusText}`);
  const baseBgBuf = Buffer.from(await baseBgResp.arrayBuffer());
  console.log('✅ Base background fetched successfully');

  let overlayHash = EVENT_OVERLAYS[event.toLowerCase()];
  if (!overlayHash) {
    console.log(`⚠️ No event overlay found for "${event}", using random water overlay`);
    const i = Math.floor(Math.random() * WATER_OVERLAYS.length);
    overlayHash = WATER_OVERLAYS[i];
  } else {
    console.log(`🎨 Using event overlay for "${event}"`);
  }

  console.log('📥 Fetching overlay from:', `https://walrus.tusky.io/${overlayHash}`);
  const overlayResp = await fetch(`https://walrus.tusky.io/${overlayHash}`);
  if (!overlayResp.ok) throw new Error(`Overlay fetch failed: ${overlayResp.status} ${overlayResp.statusText}`);
  const overlayBuf = Buffer.from(await overlayResp.arrayBuffer());
  console.log('✅ Overlay fetched successfully');

  console.log('🎨 Creating label with:', { fishName, label });
  const LABEL_WIDTH = 800;
  const LABEL_HEIGHT = 260;
  const CANVAS_HEIGHT = 2048;

  const canvas = createCanvas(LABEL_WIDTH, LABEL_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.font = 'bold 64px "NewRocker"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(fishName, LABEL_WIDTH / 3, 20);

  ctx.font = 'bold 48px "Girassol"';
  ctx.textBaseline = 'top';
  ctx.fillText(label, LABEL_WIDTH / 3, 120);

  const labelBuf = canvas.toBuffer('image/png');
  console.log('✅ Label created successfully');

  console.log('🎨 Composing final image...');
  const finalPng = await sharp(baseBgBuf)
    .resize(2048, 2048)
    .composite([
      { input: overlayBuf },
      { input: fishBuf, gravity: 'center' },
      { input: labelBuf, top: CANVAS_HEIGHT - LABEL_HEIGHT + 8, left: 40 }
    ])
    .png()
    .toBuffer();
  console.log('✅ Final image composed successfully');

  const safeFishName = sanitizeFilename(fishName);
  const safeLabel = sanitizeFilename(label);
  const fileName = `fish_${hash}_${safeFishName}_${safeLabel}.png`;
  console.log('📝 Generated filename:', fileName);

  return {
    buffer: finalPng,
    fileName
  };
}

router.get('/generate-fish-image', async (req, res) => {
  try {
    const { hash, label, fishName, event } = req.query;
    const result = await generateFishImage({ hash, label, fishName, event });

    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('Content-Type', 'image/png');
    res.send(result.buffer);
  } catch (err) {
    console.error('Error in /generate-fish-image:', err);
    res.status(500).json({ error: err.message });
  }
});

export { generateFishImage };
export default router;
