import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import sharp from 'sharp';
import tus from 'tus-js-client';

import { client, address, mintNFT, mintNFTTo } from './suiClient.js';
import { fishDb } from './fishDb.js'
import { cardsDb } from './cardsDB.js'
import { getBonusesFromCast, applyFishWeightBonuses, applyEventBonuses, applyRarityWeightBonuses, applyBaseFishRateBonus } from './castModifiers.js';
import { PlayerService } from './playerService.js';
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import { fileURLToPath } from 'url';
import { Upload } from 'tus-js-client';
import { generateFishImage } from './routes/generateFishImageRoute.js';

import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

import generateFishImageRoute from './routes/generateFishImageRoute.js';


const app = express();
dotenv.config(); 


// ——— set up persistent catchHistory DB ———
const catchFile = path.join(process.cwd(), 'catchHistory.json')
const catchAdapter = new JSONFile(catchFile)
export const catchDb = new Low(catchAdapter, { history: [] })
await catchDb.read()
catchDb.data ||= { history: [] }

// ─── in-memory store only for non-junk catches ───
const fishCatchesData = [];
const mintLocks = new Set();

const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/generate-fish-image', generateFishImageRoute);

const TUSKY_API_KEY    = process.env.TUSKY_API_KEY;
const TUSKY_VAULT_ID   = process.env.TUSKY_VAULT_ID;
const BACKGROUND_HASH = 'y_jdrf54mgy2jSI4a6pLxOMPAl1MVcsoVX-1X_ps';
const FISH_JSON       = path.join(process.cwd(), 'fish.json');

const BACKGROUND_FILE_ID = '52d47e9a-9352-4df0-bc67-957aaa56b6d2';

app.get('/tusky/:fileId', async (req, res) => {
  const { fileId } = req.params;
  console.log(`=== proxy /tusky/${fileId} ===`);
  const tuskyUrl = `https://api.tusky.io/files/${fileId}/data`;
  const tos      = await fetch(tuskyUrl, {
    headers: { 'Api-Key': process.env.TUSKY_API_KEY }
  });
  if (!tos.ok) {
    console.error(`Tusky proxy error: ${tos.status} ${tos.statusText}`);
    return res.status(tos.status).send(tos.statusText);
  }
  const buf = Buffer.from(await tos.arrayBuffer());
  console.log(`✅  proxied ${buf.length} bytes from Tusky/${fileId}`);
  res.type(tos.headers.get('Content-Type') || 'application/octet-stream');
  res.send(buf);
});

/**
 * Downloads a blob from Brightlystake's Walrus node using curl.
 * @param {string} blobId
 * @returns {Promise<Buffer>} - The binary buffer of the image
 */
async function fetchBlobWithCurl(blobId) {
  const url = `http://walrus-testnet.brightlystake.com:9185/blob/${blobId}`;
  const { stdout } = await execFileAsync('curl.exe', ['--http0.9', '--silent', '--output', '-', url], {
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  return stdout;
}



async function composeFishImage(fishHash, record) {
  console.log(`🎨 composing image layers for fishHash=${fishHash}, record:`, record);

  try {
    const result = await generateFishImage({
      hash: fishHash,
      fishName: record.type,
      label: `${record.weight} lbs • ${record.length} in`,
      event: record.event || ''  // Ensure event is always a string
    });

    // Write the buffer to a temp file
    const tmpPath = path.join(os.tmpdir(), `${fishHash}.png`);
    fs.writeFileSync(tmpPath, result.buffer);
    console.log(`💾 composed PNG written to ${tmpPath}`);

    return tmpPath;
  } catch (err) {
    console.error('Error generating fish image:', err);
    throw err;
  }
}

async function uploadToTusky(filePath) {
  const stats  = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);

  console.log(`☁️  uploading composed image ${filePath} to Tusky…`);
  // 1) start the tus upload
  const upResp = await fetch(
    `https://api.tusky.io/uploads?vaultId=${TUSKY_VAULT_ID}`,
    {
      method:  'POST',
      headers: {
        'Api-Key':        TUSKY_API_KEY,
        'Content-Type':   'application/offset+octet-stream',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
        "name": "test",
        "parentId": "11be5290-3544-4bc2-ace1-74ab7d6e6621",
      },
      body: stream,
    }
  );
  if (!upResp.ok) {
    throw new Error(`Tusky upload failed: ${upResp.statusText}`);
  }

  // 2) extract uploadId
  const location = upResp.headers.get('location');
  const uploadId = location.split('/').pop();
  console.log(`✅ upload complete, uploadId=${uploadId}`);

  // 3) poll /files/:uploadId until blobId != "unknown" (max 15 attempts)
  const maxAttempts = 200;
  const delayMs     = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`🔍 polling /files/${uploadId} for blobId (attempt ${attempt}/${maxAttempts})…`);
    const fResp = await fetch(`https://api.tusky.io/files/${uploadId}`, {
      headers: { 'Api-Key': TUSKY_API_KEY }
    });
    if (!fResp.ok) {
      throw new Error(`Tusky file-info fetch failed: ${fResp.statusText}`);
    }

    const info = await fResp.json();
    console.log('🗂️ file metadata:', info);

    if (info.blobId && info.blobId !== 'unknown') {
      console.log(`✅ got real blobId=${info.blobId}`);
      return info.blobId;
    }

    if (attempt < maxAttempts) {
      console.log(`⏳ still processing on Walrus, retrying in ${delayMs/1000}s…`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  throw new Error(`Timed out waiting for blobId after ${maxAttempts} attempts`);
}

// async function uploadToTusky(filePath) {
//   const stats  = fs.statSync(filePath);
//   const stream = fs.createReadStream(filePath);

//   console.log(`☁️  uploading composed image ${filePath} to Tusky…`);
//   // 1) start the tus upload
//   const upResp = await fetch(
//     `https://api.tusky.io/uploads?vaultId=${TUSKY_VAULT_ID}`,
//     {
//       method:  'POST',
//       headers: {
//         'Api-Key':        TUSKY_API_KEY,
//         'Content-Type':   'application/offset+octet-stream',
//         'Content-Length': stats.size,
//         'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
//       },
//       body: stream,
//     }
//   );
//   if (!upResp.ok) {
//     throw new Error(`Tusky upload failed: ${upResp.statusText}`);
//   }

//   // 2) extract uploadId
//   const location = upResp.headers.get('location');
//   const uploadId = location.split('/').pop();
//   console.log(`✅ upload complete, uploadId=${uploadId}`);

//   // 3) poll /files/:uploadId until blobId != "unknown" (max 15 attempts)
//   const maxAttempts = 200;
//   const delayMs     = 2000;
//   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
//     console.log(`🔍 polling /files/${uploadId} for blobId (attempt ${attempt}/${maxAttempts})…`);
//     const fResp = await fetch(`https://api.tusky.io/files/${uploadId}`, {
//       headers: { 'Api-Key': TUSKY_API_KEY }
//     });
//     if (!fResp.ok) {
//       throw new Error(`Tusky file-info fetch failed: ${fResp.statusText}`);
//     }

//     const info = await fResp.json();
//     console.log('🗂️ file metadata:', info);

//     if (info.blobId && info.blobId !== 'unknown') {
//       console.log(`✅ got real blobId=${info.blobId}`);
//       return info.blobId;
//     }

//     if (attempt < maxAttempts) {
//       console.log(`⏳ still processing on Walrus, retrying in ${delayMs/1000}s…`);
//       await new Promise(r => setTimeout(r, delayMs));
//     }
//   }

//   throw new Error(`Timed out waiting for blobId after ${maxAttempts} attempts`);
// }

async function mintRandomFishNFT() {
  console.log(`=== mintRandomFishNFT called ===`);

  try {
    // 1️⃣ pick a random non-junk fish
    const fishDbRaw = JSON.parse(fs.readFileSync(FISH_JSON, 'utf-8')).fish;
    const keys      = Object.keys(fishDbRaw);
    let choice, data;
    do {
      choice = keys[Math.floor(Math.random() * keys.length)];
      data   = fishDbRaw[choice];
    } while (!data['base-image'] || data['base-image'] === '-');
    console.log(`🐟 selected fish: ${choice} (hash: ${data['base-image']})`);

    // 2️⃣ Roll random metrics
    const metrics = rollFishMetrics(data);
    console.log(`📏 Rolled metrics:`, metrics);

    // 3️⃣ Randomly select an event (or none)
    const events = ['blood', 'frozen', 'nightmare', 'toxic', null];
    const event = events[Math.floor(Math.random() * events.length)];
    console.log(`🎲 Selected event:`, event || 'none');

    // 4️⃣ compose the layered image
    const record = {
      type: choice,
      weight: metrics.weight,
      length: metrics.length,
      event: event || ''  // Ensure event is always a string, even if null
    };
    console.log(`🎨 Composing image with record:`, record);
    
    const tmpFile = await composeFishImage(data['base-image'], record);
    console.log(`☁️  composed image ready at ${tmpFile}`);

    // 5️⃣ upload it
    console.log(`☁️  uploading composed image to Tusky…`);
    const fileId = await uploadToTusky(tmpFile);
    console.log(`🔗 uploaded, received blobId=${fileId}`);
    const url = `https://walrus.tusky.io/${fileId}`;

    // 6️⃣ mint the NFT on chain
    console.log(`🚀 minting NFT on chain…`);
    const result = await mintNFT({
      name:        choice,
      description: `A ${choice}${event ? ` caught during a ${event} event` : ''} weighing ${metrics.weight} lbs and measuring ${metrics.length} inches`,
      imageUrl:    url,
      thumbnailUrl:url,
    });
    console.log(`🏷️  mint complete, digest=${result.digest}`);

    return {
      type:          choice,
      digest:        result.digest,
      objectChanges: result.objectChanges,
      event:         event,
      weight:        metrics.weight,
      length:        metrics.length
    };
  } catch (err) {
    console.error('Error in mintRandomFishNFT:', err);
    throw err; // Re-throw to be handled by the endpoint
  }
}

app.post('/mint-fish', async (req, res) => {
  console.log('=== /mint-fish called ===');
  try {
    const result = await mintRandomFishNFT();
    console.log('=== /mint-fish returning success ===', result);
    res.json({ 
      success: true, 
      fishType: result.type, 
      digest: result.digest, 
      objectChanges: result.objectChanges,
      event: result.event,
      weight: result.weight,
      length: result.length
    });
  } catch (err) {
    console.error('=== /mint-fish error ===', err);
    res.status(500).json({ 
      error: err.message,
      stack: err.stack // Include stack trace for debugging
    });
  }
});

// app.post('/mint-fish', async (_req, res) => {
//   console.log('=== /mint-fish called ===');
//   try {
//     const minted = await mintRandomFishNFT();
//     res.json({ success: true, ...minted });
//   } catch (err) {
//     console.error('=== /mint-fish error ===', err);
//     res.status(500).json({ error: err.message });
//   }
// });

// … finally, your existing server start
app.listen(process.env.PORT||3000, () => {
  console.log('Server running…');
});


/**
 * Mint a random, non-junk fish NFT using its `base-image` hash.
 * @returns {Promise<{ type: string; digest: string; objectChanges: any[] }>}
 */

/**
 * Print a breakdown to the console, color-coded by rarity.
 * @param {Record<string, number>} breakdown  // fishType → count
 * @param {Record<string, any>} fishIndex     // fishDb.data.fish map
 */

/**
 * Persist a single catch into catchHistory, catchDb, and log it.
 * @param {{ playerId: string, catch: { type: string } , event: string|null }} catchRecord
 */

// read existing file (or initialize if missing)
await catchDb.read()

app.get('/balance', async (_, res) => {
  try {
    const { totalBalance } = await client.getBalance({ owner: address }); // BigInt
    const balanceSui = Number(totalBalance) / 1e9;  // mist → SUI
    res.json({ address, balanceSui });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`Testnet address: ${address}`);
});

app.get('/', (_, res) => {
  res.send(`
    <h1>SUI Game API</h1>
    <ul>
      <li><a href="/balance">/balance</a> – your Testnet balance</li>
      <li><a href="/play" onclick="fetch('/play',{method:'POST'}).then(r=>r.json()).then(j=>alert(JSON.stringify(j)))">/play</a> – play the game</li>
    </ul>
  `);
});

app.post('/mint', async (req, res) => {
  try {
    const { name, description, imageUrl, thumbnailUrl } = req.body;

    const result = await mintNFT({
      name,
      description,
      imageUrl,
      thumbnailUrl,
    });

    res.json({
      success: true,
      digest: result.digest,
      objectChanges: result.objectChanges,
    });
  } catch (err) {
    console.error('NFT minting failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/mint-fish', async (_req, res) => {
  try {
    const { type, digest, objectChanges } = await mintRandomFishNFT();
    res.json({
      success:       true,
      fishType:      type,
      digest,
      objectChanges,
    });
  } catch (err) {
    console.error('Random fish minting failed:', err);
    res.status(500).json({ error: err.message });
  }
});


async function createNewPlayer(googleSub) {
  return await PlayerService.initializePlayer(googleSub);
}

// POST /player/init → ensure a player exists, return their state
app.post('/player/init', async (req, res) => {
  console.log('🎯 /player/init called with body:', req.body);
  const { googleSub } = req.body;
  if (!googleSub) {
    console.log('❌ No googleSub provided');
    return res.status(400).json({ error: 'googleSub required' });
  }

  console.log('🔍 Looking for player with googleSub:', googleSub);
  try {
    const player = await PlayerService.ensurePlayer(googleSub);
    console.log('✅ Player found/created:', player);
    return res.json({ 
      googleSub, 
      state: player, 
      created: !player.utcTimestamp || Date.now() - player.utcTimestamp < 5000 // Roughly 5 seconds
    });
  } catch (error) {
    console.error('💥 Error initializing player:', error);
    console.error('💥 Error stack:', error.stack);
    return res.status(500).json({ error: 'Failed to initialize player' });
  }
});

app.get('/players', async (req, res) => {
  try {
    const players = await PlayerService.getAllPlayers();
    res.json(players);
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

// -- DB -- //
app.get('/player/:googleSub', async (req, res) => {
  try {
    const googleSub = req.params.googleSub;
    const player = await PlayerService.getPlayer(googleSub);

    if (!player) {
      return res
        .status(404)
        .json({ error: `Player "${googleSub}" not found.` });
    }

    res.json({ googleSub, state: player });
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});


// Update a player's state
app.post('/player/:googleSub', async (req, res) => {
  try {
    const googleSub = req.params.googleSub;
    const updates = req.body;
    
    const updatedPlayer = await PlayerService.updatePlayer(googleSub, updates);
    res.json({ googleSub, state: updatedPlayer });
  } catch (error) {
    console.error('Error updating player:', error);
    res.status(500).json({ error: 'Failed to update player' });
  }
});

/**
 * GET /player-info/:googleSub
 * Returns the full player object (hand, deck, state, etc.)
 */
app.get('/player-info/:googleSub', async (req, res) => {
  const { googleSub } = req.params;
  if (!googleSub) {
    return res.status(400).json({ error: 'googleSub required' });
  }

  try {
    const player = await PlayerService.getPlayer(googleSub);
    if (!player) {
      return res.status(404).json({ error: `Player "${googleSub}" not found.` });
    }

    return res.json({ googleSub, ...player });
  } catch (error) {
    console.error('Error fetching player info:', error);
    return res.status(500).json({ error: 'Failed to fetch player info' });
  }
});

/**
 * POST /players/refill-decks
 * Re‐deals every player:
 *  • a fresh 20‐card `deck`
 *  • a fresh  3‐card `hand`
 */
app.post('/players/refill-decks', async (req, res) => {
  try {
    // 1) Reload card pool & get all players
    await cardsDb.read();
    const players = await PlayerService.getAllPlayers();

    // 2) Update each player's deck and hand
    for (const player of players) {
      const newDeck = await generateRandomDeck(20);
      const newHand = await generateRandomDeck(3);
      
      await PlayerService.updatePlayer(player.google_sub, {
        deck: newDeck,
        deckCount: newDeck.length,
        hand: newHand
      });
    }

    // 3) Return success
    res.json({ success: true, message: 'All player decks refilled' });
  } catch (error) {
    console.error('Error refilling decks:', error);
    res.status(500).json({ error: 'Failed to refill decks' });
  }
});


// --- New Fish routes ---

// GET all fish types & stats
app.get('/fish', async (req, res) => {
  await fishDb.read()
  res.json(fishDb.data.fish)
})

// GET a single fish by key (e.g. "salmon")
app.get('/fish/:type', async (req, res) => {
  await fishDb.read()
  const f = fishDb.data.fish[req.params.type]
  if (!f) return res.status(404).send()
  res.json({ type: req.params.type, stats: f })
})

/**
 * Build a random deck of `size` card‐indices based on your cards.json
 */
export async function generateRandomDeck(size = 20) {
  // re-read to get the latest data
  await cardsDb.read();

  // cardsDb.data.cards is an object: name → cardData
  const cardList = Object.values(cardsDb.data.cards);

  const deck = [];
  for (let i = 0; i < size; i++) {
    // pick a random card object
    const randomCard = 
      cardList[Math.floor(Math.random() * cardList.length)];
    // push its `index` field
    deck.push(randomCard.index);
  }
  return deck;
}

/**
 * Roll a random weight (and length) for a caught fish,
 * but only if its rarity isn't "junk".
 *
 * @param {{ rarity: string, 'min-weight': number, 'max-weight': number, 'min-length': number, 'max-length': number }} stats
 * @returns {{ weight: number|null, length: number|null }}
 */
function rollFishMetrics(stats) {
  if (stats.rarity === 'junk') {
    return { weight: null, length: null };
  }

  const minW = stats['min-weight'];
  const maxW = stats['max-weight'];
  const weight = parseFloat(
    (minW + Math.random() * (maxW - minW)).toFixed(2)
  );

  const minL = stats['min-length'];
  const maxL = stats['max-length'];
  const length = parseFloat(
    (minL + Math.random() * (maxL - minL)).toFixed(2)
  );

  return { weight, length };
}

// In-memory store for all casts
const playerCasts = [];

/**
 * Adds a new cast (array of ints) to the playerCasts list.
 * @param {number[]} castArray
 */
function playercast(castArray) {
  // optional: validate each item is an integer
  if (!Array.isArray(castArray) || !castArray.every(n => Number.isInteger(n))) {
    throw new Error('playercast expects an array of integers');
  }
  playerCasts.push({
    cast: castArray,
    timestamp: new Date().toISOString(),
  });
}

app.post('/playercast', async (req, res) => {
  const { googleSub, cast } = req.body;

  // 0) Basic validation
  if (!googleSub || !Array.isArray(cast)) {
    return res.status(400).json({ error: 'googleSub and cast[] required' });
  }

  try {
    // 0.5) Ensure the player exists
    const player = await PlayerService.getPlayer(googleSub);
    if (!player) {
      return res.status(400).json({ error: `Player "${googleSub}" not found.` });
    }

    // 0.75) Verify cast matches hand
    if (cast.length !== player.hand.length) {
      return res.status(400).json({ error: `Cast length must be ${player.hand.length}` });
    }
    for (let i = 0; i < cast.length; i++) {
      if (cast[i] > -1 && cast[i] !== player.hand[i]) {
        return res
          .status(400)
          .json({ error: `Slot ${i} must be ${player.hand[i]}, got ${cast[i]}` });
      }
    }

    // 1) Prevent duplicate pending casts
    if (playerCasts.some(c => c.googleSub === googleSub)) {
      return res.status(400).json({ error: 'You already have a pending cast.' });
    }

    // 2) Prevent new cast if unclaimed still exist
    if (unclaimedCatches.some(c => c.googleSub === googleSub)) {
      return res.status(400).json({ error: 'Claim your previous catch first.' });
    }

    // 3) Queue the cast
    const bonuses = getBonusesFromCast(cast);
    const record = {
      googleSub,
      cast,
      depth: pickDepth(),
      bonuses,
      timestamp: new Date().toISOString(),
    };
    playerCasts.push(record);

    // 4) Draw replacements for each used card
    const updatedHand = [...player.hand];
    const updatedDeck = [...player.deck];
    
    for (let i = 0; i < cast.length; i++) {
      if (cast[i] > -1) {
        if (updatedDeck.length > 0) {
          const drawPos   = Math.floor(Math.random() * updatedDeck.length);
          const [newCard] = updatedDeck.splice(drawPos, 1);
          updatedHand[i]  = newCard;
        } else {
          // no more cards in deck → clear that slot
          updatedHand[i] = -1;
        }
      }
    }

    // 5) Update player state in database
    await PlayerService.updatePlayer(googleSub, {
      hand: updatedHand,
      deck: updatedDeck,
      deck_count: updatedDeck.length,
      state: 2
    });

    return res.json({
      success:   true,
      newHand:   updatedHand,
      deckCount: updatedDeck.length
    });
  } catch (error) {
    console.error('Error in playercast:', error);
    return res.status(500).json({ error: 'Failed to process cast' });
  }
});


app.post('/claim', async (req, res) => {
  const { googleSub } = req.body;
  if (!googleSub) {
    return res.status(400).json({ error: 'googleSub required' });
  }

  try {
    // find and remove from in-memory unclaimedCatches
    const idx = unclaimedCatches.findIndex(c => c.googleSub === googleSub);
    if (idx < 0) {
      return res.status(404).json({ error: 'No unclaimed catch' });
    }
    const [claimed] = unclaimedCatches.splice(idx, 1);

    // update player record: reset state → 1 and remove the saved catch
    await PlayerService.updatePlayer(googleSub, {
      state: 1,
      catch: null
    });

    return res.json({ success: true, claimed });
  } catch (error) {
    console.error('Error claiming catch:', error);
    return res.status(500).json({ error: 'Failed to claim catch' });
  }
});


// GET /playercasts → returns the full array
app.get('/playercasts', (req, res) => { res.json(playerCasts);});
app.get('/unclaimed', (_, res) => res.json(unclaimedCatches));
app.get('/history', (_, res) => res.json(catchHistory))

// ─── at top of your file, alongside other in-memory stores ───
const phases = ['dawn', 'day', 'dusk', 'night'];
let currentPhaseIndex = 0; // start at 'dawn'
let currentHour = 0;
let lastGameLoopTime = Date.now(); // Track when the last game loop ran
const playerCatches = [];
const unclaimedCatches = [];
const catchHistory = [];
let lastPhase = phases[currentPhaseIndex];
let lastEvent = null;
let lastPoolBreakdown = {};

/**
 * Main game loop. Every interval:
 *  - Reads fishDb
 *  - For each pending player cast, picks a random fish
 *  - Records the catch in playerCatches
 *  - Clears playerCasts so players can cast again
 */
async function gameLoop() {
  // 0) snapshot the current time & phase for this loop
  const currentHourSnapshot  = currentHour;
  const currentPhaseSnapshot = lastPhase;
  const currentPhaseHour     = (currentHourSnapshot % 6) + 1;  // 1–6
  
  // Update the last game loop time
  lastGameLoopTime = Date.now();

  // 1) pull & clear pending casts
  const castsToProcess = [...playerCasts];
  playerCasts.length   = 0;

  // 2) tally votes *for* the next loop's event
  const voteCounts = {};
  for (const rec of castsToProcess) {
    applyEventBonuses(voteCounts, rec.bonuses);
  }
  let nextEvent = null;
  if (Object.keys(voteCounts).length) {
    const entries  = Object.entries(voteCounts);
    const maxVotes = Math.max(...entries.map(([,c]) => c));
    const top      = entries.filter(([,c]) => c === maxVotes).map(([e]) => e);
    nextEvent      = top[Math.floor(Math.random() * top.length)];
  }

  // 3) snapshot the event *currently* in effect
  const currentEvent = lastEvent;

  // console.log(`🕰️ Hour ${currentHourSnapshot} (Phase ${currentPhaseSnapshot} ${currentPhaseHour}/6)`);
  // console.log(`🎯 event: ${currentEvent || 'none'}`);

  // 4) build the shared pool using currentPhaseSnapshot & currentEvent
  await fishDb.read();
  const allEntries = Object.entries(fishDb.data.fish)
    .filter(([, stats]) =>
      isFishCurrentlyActive(stats, currentPhaseSnapshot, currentEvent)
    )
    .map(([type, stats]) => {
      let rate = Number(stats['base-catch-rate'] || 0);
      if (currentEvent && Array.isArray(stats['event-variations'])) {
        const ev = stats['event-variations'].find(x => x.event === currentEvent);
        if (ev?.multiplier) rate *= ev.multiplier;
      }
      return [type, { ...stats, 'base-catch-rate': rate }];
    });

  const pool = [];
  const SAMPLE_SIZE = 900;
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const pick = pickWeighted(allEntries);
    if (pick) pool.push({ type: pick[0], stats: pick[1] });
  }

  // optional: log pool breakdown
    // const breakdown = pool.reduce((acc, f) => {
    //   acc[f.type] = (acc[f.type] || 0) + 1;
    //   return acc;
    // }, {});
    // printPoolBreakdown(breakdown, fishDb.data.fish);

  // 5) each player draws under currentPhaseSnapshot/currentEvent
  for (const rec of castsToProcess) {
    let pickList = pool.map(f => [f.type, f.stats]);
    pickList = applyFishWeightBonuses(pickList, rec.bonuses);
    pickList = applyRarityWeightBonuses(pickList, rec.bonuses);
    pickList = applyBaseFishRateBonus(pickList, rec.bonuses);

    let totalWeight = 0;
    const cumulative = pickList.map(([type, stats]) => {
      totalWeight += Number(stats['base-catch-rate'] || 0);
      return { threshold: totalWeight, type, stats };
    });

    if (!cumulative.length) {
      console.warn(`⚠️ No fish in personal pool for ${rec.googleSub}, skipping…`);
      continue;
    }

    const r      = Math.random() * totalWeight;
    const winner = cumulative.find(e => r < e.threshold) || cumulative[cumulative.length - 1];
    // console.log(`🎲 draw ${r.toFixed(2)} / ${totalWeight.toFixed(2)} → ${winner.type}`);

    const metrics = rollFishMetrics(winner.stats);

    // assemble the catch record
    const catchRecord = {
      googleSub: rec.googleSub,
      playerId: rec.googleSub, // Keep for backward compatibility
      cast:      rec.cast,
      depth:     winner.stats.depths,
      catch:     { type: winner.type, stats: winner.stats },
      event:     currentEvent,
      phase:     currentPhaseSnapshot,
      at:        new Date().toISOString(),
    
      // add the rolled weight & length
      weight:    metrics.weight,
      length:    metrics.length,
    };

    // ONLY record non-junk (i.e. real fish) into fishCatchesData
    if (winner.stats.rarity !== 'junk') {
      fishCatchesData.push({
        googleSub: catchRecord.googleSub,
        type:     catchRecord.catch.type,
        at:       catchRecord.at,
        weight:   catchRecord.weight,
        length:   catchRecord.length,
        minted:   catchRecord.minted,
        event:    catchRecord.event
      });
    }

    // enqueue for later claiming
    unclaimedCatches.push(catchRecord);

    await recordCatchHistory(catchRecord);

    // mark player as "has a catch to claim"
    try {
      await PlayerService.updatePlayer(rec.googleSub, {
        state: 3,
        catch: {
          type:   catchRecord.catch.type,
          at:     catchRecord.at,
          weight: catchRecord.weight,
          length: catchRecord.length,
          minted: false
        }
      });
    } catch (error) {
      console.error('Error updating player state after catch:', error);
    }
  }

  // 6) only *now* update lastEvent for the next loop
  lastEvent = nextEvent;

  // 7) advance the clock & possibly roll into a new phase
  currentHour = (currentHour + 1) % 24;
  const newPhaseIndex = Math.floor(currentHour / 6);
  if (newPhaseIndex !== currentPhaseIndex) {
    const oldPhase = lastPhase;
    currentPhaseIndex = newPhaseIndex;
    lastPhase = phases[currentPhaseIndex];
    // console.log(`⏩ Phase: ${oldPhase} → ${lastPhase}`);
  }

   // ✨ when we wrap back to hour 0, reset every player's deck
   if (currentHour === 0) {
    // console.log("🌑 It's dawn—resetting all player decks and hands");
    await cardsDb.read();

    try {
      const players = await PlayerService.getAllPlayers();
      
          for (const player of players) {
      // brand-new deck of 20
      const newDeck = await PlayerService.generateRandomDeck(20);
      // brand-new hand of 3
      const newHand = await PlayerService.generateRandomDeck(3);

              await PlayerService.updatePlayer(player.google_sub, {
          deck: newDeck,
          deck_count: newDeck.length,
          hand: newHand
          // // reset their active_hand slots
          // active_hand: [-1, -1, -1],
          // // optionally reset state back to "can cast" (1)
          // state: 1
        });
    }
    } catch (error) {
      console.error('Error resetting player decks:', error);
    }
  }

  // console.log(`✅ gameLoop complete\n--------------------------------\n`);
}

// start immediately, then every 20 seconds
gameLoop();
setInterval(gameLoop, 20_000);

/**
 * Given an array of [key, stats] entries, each with a numeric
 * stats['base-catch-rate'], returns one entry chosen by weight.
 */
function pickWeighted(fishEntries) {
  // 1) build cumulative weights
  const cumulative = [];
  let total = 0;
  for (const [type, stats] of fishEntries) {
    const w = Number(stats['base-catch-rate'] || 0);
    if (w <= 0) continue;          // skip zero-weight fish
    total += w;
    cumulative.push([total, type, stats]);
  }
  if (total === 0) return null;   // fallback if nothing has weight

  // 2) draw a random number from [0, total)
  const r = Math.random() * total;

  // 3) find first cumulative weight ≥ r
  for (const [cumWeight, type, stats] of cumulative) {
    if (r < cumWeight) {
      return [type, stats];
    }
  }
  // should never get here, but return the last
  const last = cumulative[cumulative.length - 1];
  return [last[1], last[2]];
}

/**
 * Pick a depth tier based on weighted probabilities.
 * Tiers:
 *  - shoals:  80
 *  - shelf:   50
 *  - dropoff: 20
 *  - canyon:   5
 *  - abyss:    0.1
 */
function pickDepth() {
  const weights = {
    shoals:  80,
    shelf:   50,
    dropoff: 20,
    canyon:   5,
    abyss:    0.1,
  };

  // Build a cumulative weight array
  const cumulative = [];
  let total = 0;
  for (const [tier, w] of Object.entries(weights)) {
    total += w;
    cumulative.push({ tier, threshold: total });
  }

  // Draw a random number in [0, total)
  const r = Math.random() * total;

  // Find first threshold > r
  for (const { tier, threshold } of cumulative) {
    if (r < threshold) {
      return tier;
    }
  }
  // Fallback
  return cumulative[cumulative.length - 1].tier;
}

// Example usage:
const experiments = 100000;
const counts = { shoals:0, shelf:0, dropoff:0, canyon:0, abyss:0 };
for (let i = 0; i < experiments; i++) {
  counts[pickDepth()]++;
}
console.log(
  Object.fromEntries(
    Object.entries(counts).map(([t,c]) => [t, (c/experiments*100).toFixed(2)+'%'])
  )
);
// → e.g. { shoals: "44.8%", shelf: "28.3%", dropoff: "11.4%", canyon: "2.7%", abyss: "0.1%" }

/**
 * Selects one fish entry ([type, stats]) given:
 *  - fishEntries: Array of [type, stats]
 *  - depth: one of "shoals","shelf","dropoff","canyon","abyss"
 *  - phase: one of your phases ("dawn","day","dusk","night")
 *
 * Returns [type, stats] or null if no fish match.
 */
function selectFishByDepthAndPhase(fishEntries, depth, phase) {
  // 1) Filter by depth tier
  const depthFiltered = fishEntries.filter(([, stats]) =>
    Array.isArray(stats.depths) &&
    stats.depths.includes(depth)
  );
  if (depthFiltered.length === 0) return null;

  // 2) Filter by feed-hours
  const feedFiltered = depthFiltered.filter(([, stats]) =>
    Array.isArray(stats['feed-hours']) &&
    stats['feed-hours'].includes(phase)
  );
  const pickList = feedFiltered.length ? feedFiltered : depthFiltered;

  // 3) Weighted pick (uses your existing pickWeighted)
  return pickWeighted(pickList);
}



// (Optional) expose an endpoint to inspect past catches:
app.get('/catches', (req, res) => {
  res.json(playerCatches);
});

// ─── State endpoint ───
app.get('/state', (req, res) => {
  const now = Date.now();
  const timeSinceLastLoop = now - lastGameLoopTime;
  const timeUntilNextHour = Math.max(0, 20000 - timeSinceLastLoop); // 20 seconds = 20000ms
  
  res.json({
    phase: lastPhase,
    event: lastEvent,
    hour: currentHour,
    catches: playerCatches,
    timeUntilNextHour: Math.ceil(timeUntilNextHour / 1000), // Convert to seconds
  });
});

// app.post('/playercast', async (req, res) => {
//   const { playerId, cast, cards = [] } = req.body;

//   // 0) Basic validation
//   if (!playerId || !Array.isArray(cast)) {
//     return res.status(400).json({ error: 'playerId and cast[] required' });
//   }

//   // 0.5) Ensure the player has been initialized in your LowDB
//   await db.read();
//   if (!db.data.players[playerId]) {
//     return res
//       .status(400)
//       .json({ error: `Player "${playerId}" not found. Please init first.` });
//   }

//   // 1) Prevent duplicate pending casts
//   if (playerCasts.some(c => c.playerId === playerId)) {
//     return res
//       .status(400)
//       .json({ error: 'You already have a pending cast. Wait for that to process.' });
//   }

//   // 2) Prevent new cast if you haven't claimed your last catch
//   if (unclaimedCatches.some(c => c.playerId === playerId)) {
//     return res
//       .status(400)
//       .json({ error: 'Claim your previous catch before casting again.' });
//   }

//   // 3) Build the cast record with depth + card-based bonuses
//   const bonuses = getBonusesFromCast(cards);
//   const record = {
//     playerId,
//     cast,
//     depth: pickDepth(),
//     cards,
//     bonuses,
//     timestamp: new Date().toISOString(),
//   };

//   playerCasts.push(record);
//   return res.json({ success: true });
// });


function isFishCurrentlyActive(stats, phase, chosenEvent) {
  // 1) must feed during this phase
  if (
    !Array.isArray(stats['feed-hours']) ||
    !stats['feed-hours'].includes(phase)
  ) {
    return false;
  }

  // 2) if they've defined an only-active-events list, require match
  if (
    Array.isArray(stats['only-active-events']) &&
    stats['only-active-events'].length > 0
  ) {
    return chosenEvent != null &&
           stats['only-active-events'].includes(chosenEvent);
  }

  // otherwise, it's active
  return true;
}

function printPoolBreakdown(breakdown, fishIndex) {
  // ANSI colors
  const C = {
    reset:     '\x1b[0m',
    junk:      '\x1b[90m',   // grey
    common:    '\x1b[37m',   // white
    uncommon:  '\x1b[32m',   // green
    rare:      '\x1b[34m',   // blue
    legendary: '\x1b[33m',   // yellow/orange
    mythic:    '\x1b[35m',   // magenta (as a stand-in)
  };

  // console.log(`🎯 Pool breakdown (${Object.values(breakdown).reduce((a,b)=>a+b,0)}):`);
  for (const [type, count] of Object.entries(breakdown)) {
    const stats = fishIndex[type] || {};
    const rarity = stats.rarity || 'common';
    const color = C[rarity] || C.common;
    //console.log(`${color}  • ${type}: ${count}${C.reset}`);
  }
}

async function recordCatchHistory(catchRecord) {
  const time = new Date().toLocaleTimeString('en-US');
  
  // only include the event segment if there is an event
  const eventSegment = catchRecord.event ? ` (${catchRecord.event})` : '';
  
  // only include the weight segment if weight is not null
  const weightSegment = (catchRecord.weight != null)
    ? ` [${catchRecord.weight} lbs]`
    : '';
  
  const line = 
    `${catchRecord.googleSub}: ${catchRecord.catch.type}` +
    `${weightSegment}` +
    `${eventSegment} @${time}`;

  // in-memory history
  catchHistory.push(line);

  // on-disk history
  catchDb.data.history.push(line);
  await catchDb.write();

  // console log
  console.log(`🎣 ${catchRecord.googleSub} caught ${catchRecord.catch.type}${weightSegment}`);
}

app.get('/time', (req, res) => {
  res.json({ hour: currentHour });
});

// return in-memory history
app.get('/catch-history', (req, res) => {
  res.json({ history: catchHistory });
});

// — or, if you'd rather serve the on-disk version: —
app.get('/catch-history/persisted', async (req, res) => {
  await catchDb.read();
  res.json({ history: catchDb.data.history });
});

// GET all fish catches
app.get('/fish-catches', (req, res) => {
  res.json(fishCatchesData);
});

// GET all fish catches for a specific player
app.get('/fish-catches/:googleSub', (req, res) => {
  const { googleSub } = req.params;
  const matches = fishCatchesData.filter(c => c.googleSub === googleSub);
  res.json(matches);
});

app.post('/auto-catch-all', async (_req, res) => {
  try {
    // 1) load players & fish index
    await fishDb.read();
    const players = await PlayerService.getAllPlayers();
    const fishMap = fishDb.data.fish;

    const newCatches = [];

    for (const player of players) {
      // pick random non-junk
      const entries = Object.entries(fishMap)
        .filter(([, stats]) => stats['base-image'] && stats.rarity !== 'junk');
      if (entries.length === 0) continue;
      const [type, stats] = entries[Math.floor(Math.random() * entries.length)];

      // roll weight/length
      const { weight, length } = rollFishMetrics(stats);

      const catchRecord = {
        googleSub: player.google_sub,
        catch: { type, stats },
        at:     new Date().toISOString(),
        weight,
        length,
        minted: false, 
      };

      // record in memory & history
      fishCatchesData.push({
        googleSub: player.google_sub, type, at: catchRecord.at, weight, length
      });
      unclaimedCatches.push(catchRecord);
      await recordCatchHistory(catchRecord);

      // mark player as "has an unclaimed catch"
      await PlayerService.updatePlayer(player.google_sub, {
        state: 3,
        catch: {
          type, at: catchRecord.at, weight, length
        }
      });

      newCatches.push(catchRecord);
    }

    res.json({ success: true, newCatches });
  } catch (err) {
    console.error('/auto-catch-all error', err);
    res.status(500).json({ error: err.message });
  }
});

// 1️⃣ Helper: mints the caught fish NFT for a player→recipient
async function mintCaughtFishNFTFor(googleSub, recipient) {
  // find the first un-minted catch
  const rec = fishCatchesData.find(c => c.googleSub === googleSub);
  if (!rec) {
    throw new Error(`No caught fish found for player "${googleSub}"`);
  }

  // compose & upload
  const tmp    = await composeFishImage(rec.catch.stats['base-image'], rec);
  const blobId = await uploadToTusky(tmp);
  const url    = `https://walrus.tusky.io/${blobId}`;

  // mint to arbitrary wallet
  const result = await mintNFTTo({
    recipient,
    name:        rec.catch.type,
    description: `Your caught ${rec.catch.type}`,
    imageUrl:    url,
    thumbnailUrl:url,
  });

  return {
    digest: result.digest,
    fishType: rec.catch.type,
  };
}

const mintQueue = [];
const completedMints = []; // Track completed mints with their NFT hashes

app.post('/mint-caught-fish', async (req, res) => {
  console.log('=== /mint-caught-fish called with', req.body);
  const { googleSub, walletAddress, index } = req.body;

  if (typeof googleSub !== 'string' || typeof walletAddress !== 'string' || typeof index !== 'number') {
    return res.status(400).json({
      error: 'googleSub (string), walletAddress (string), and index (number) required'
    });
  }

  if (mintLocks.has(googleSub)) {
    return res.status(429).json({ error: 'Mint in progress, please wait.' });
  }

  mintLocks.add(googleSub);

  const playerCatches = fishCatchesData.filter(c => c.googleSub === googleSub);
  if (playerCatches.length === 0) {
    return res.status(404).json({ error: `No catches found for player ${googleSub}` });
  }
  if (index < 0 || index >= playerCatches.length) {
    return res.status(400).json({ error: `Index out of range (0–${playerCatches.length - 1})` });
  }

  const record = playerCatches[index];
  if (record.minted) {
    return res.status(400).json({ error: 'That fish has already been minted' });
  }

  // Make sure the mint is actually a fish and not junk
  if (record.type === 'junk') {
    return res.status(400).json({ error: 'Junk fish cannot be minted' });
  }

  mintLocks.add(googleSub);

  try {
    await fishDb.read();
    const fishStats = fishDb.data.fish[record.type];
    if (!fishStats || !fishStats['base-image'] || fishStats['base-image'] === '-') {
      throw new Error(`No base-image for fish type "${record.type}"`);
    }
    const hash = fishStats['base-image'];

    const tmp = await composeFishImage(hash, record);
    const stats = fs.statSync(tmp);
    const stream = fs.createReadStream(tmp);

    const parentId = "11be5290-3544-4bc2-ace1-74ab7d6e6621";
    const name = `${record.type} | ${record.weight} Lbs | ${record.length} Inch - ${record.googleSub} @${record.at}` ;

    const upResp = await fetch(
      `https://api.tusky.io/uploads?vaultId=${TUSKY_VAULT_ID}&parentId=${parentId}&filename=${name}`,
      {
        method: 'POST',
        headers: {
          'Api-Key': TUSKY_API_KEY,
          'Content-Type': 'application/offset+octet-stream',
          'Content-Length': stats.size,
          'Content-Disposition': `attachment; filename="${path.basename(tmp)}"`,
        },
        body: stream,
      }
    );

    if (!upResp.ok) {
      throw new Error(`Tusky upload failed: ${upResp.statusText}`);
    }

    const location = upResp.headers.get('location');
    const uploadId = location.split('/').pop();
    console.log(`⏳ queued for minting: uploadId=${uploadId}`);

    mintQueue.push({
      googleSub,
      walletAddress,
      index,
      fishType: record.type,
      uploadId,
      description: `${record.weight} Lbs - ${record.length} Inch ${record.at}`,
      createdAt: Date.now(),
    });

    return res.json({ success: true, status: 'queued', uploadId });

  } catch (err) {
    console.error('mint-caught-fish error', err);
    return res.status(500).json({ error: err.message });
  } finally {
    mintLocks.delete(googleSub);
  }
});

setInterval(async () => {
  for (const item of [...mintQueue]) {
    try {
      const fResp = await fetch(`https://api.tusky.io/files/${item.uploadId}`, {
        headers: { 'Api-Key': TUSKY_API_KEY }
      });
      if (!fResp.ok) continue;

      const info = await fResp.json();
      if (info.blobId && info.blobId !== 'unknown') {
        const url = `https://walrus.tusky.io/${info.blobId}`;
        const result = await mintNFTTo({
          recipient: item.walletAddress,
          name: item.fishType,
          description: item.description,
          imageUrl: url,
          thumbnailUrl: url
        });
        console.log('🧾 Full mintNFTTo result:', JSON.stringify(result, null, 2));
        console.log(`✅ Minted NFT for ${item.googleSub}: ${result.digest}`);

        // Fetch transaction effects to get the created objectId
        let nftObjectId = null;
        const maxAttempts = 15;
        const delayMs = 2000;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            console.log(`🔍 Fetching transaction ${result.digest} (attempt ${attempt}/${maxAttempts})...`);
            const effects = await client.getTransactionBlock({ 
              digest: result.digest,
              options: {
                showEffects: true,
                showObjectChanges: true,
                showInput: false,
                showEvents: false
              }
            });
            console.log('🧾 Full transaction response:', JSON.stringify(effects, null, 2));
            
            // Check if we have objectChanges
            if (effects.objectChanges && effects.objectChanges.length > 0) {
              console.log(`📦 Found ${effects.objectChanges.length} object changes:`);
              effects.objectChanges.forEach((change, index) => {
                console.log(`  ${index + 1}. Type: ${change.type}, ObjectId: ${change.objectId || 'N/A'}`);
              });
              
              // Look for created objects (NFTs)
              const createdObject = effects.objectChanges.find(change => change.type === 'created');
              if (createdObject) {
                nftObjectId = createdObject.objectId;
                console.log(`🎯 Found NFT Object ID: ${nftObjectId}`);
                break;
              } else {
                console.log('⚠️ No "created" object found in objectChanges');
              }
            } else {
              console.log('⚠️ No objectChanges found in transaction response');
            }
            
            // If we got here, no object yet, but transaction exists
            break;
          } catch (e) {
            if (attempt === maxAttempts) {
              console.error('Failed to fetch transaction effects after max attempts:', e);
            } else {
              console.log(`⏳ Transaction not found yet (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s...`);
              await new Promise(res => setTimeout(res, delayMs));
            }
          }
        }

        // Store the completed mint with both transaction hash and object ID
        completedMints.push({
          uploadId: item.uploadId,
          googleSub: item.googleSub,
          walletAddress: item.walletAddress,
          index: item.index,
          nftHash: result.digest,
          nftObjectId: nftObjectId,
          completedAt: Date.now()
        });

        // Find all catches for this player and mark the specific one as minted
        const playerCatches = fishCatchesData.filter(c => c.googleSub === item.googleSub);
        if (item.index >= 0 && item.index < playerCatches.length) {
          // Find the actual index in the main fishCatchesData array
          const actualIndex = fishCatchesData.findIndex(c => 
            c.googleSub === item.googleSub && 
            c.type === playerCatches[item.index].type &&
            c.at === playerCatches[item.index].at
          );
          if (actualIndex >= 0) {
            fishCatchesData[actualIndex].minted = true;
          }
        }

        mintQueue.splice(mintQueue.indexOf(item), 1);
      }
    } catch (err) {
      console.error(`💥 Minting failed for ${item.uploadId}:`, err.message);
    }
  }
}, 30000);

app.get('/mint-queue', (req, res) => {
  
  const queueInfo = mintQueue.map(item => ({
    googleSub: item.googleSub,
    walletAddress: item.walletAddress,
    fishType: item.fishType,
    uploadId: item.uploadId,
    createdAt: item.createdAt,
    status: 'pending',
    timeInQueue: Date.now() - item.createdAt
  }));

  res.json({
    queueLength: mintQueue.length, 
    items: queueInfo
  });
});

// Endpoint to cancel and clear the mint queue
app.post('/mint-queue/cancel', (req, res) => {
  mintQueue.length = 0;
  res.json({ success: true, message: 'Mint queue cleared.' });
});

// Endpoint to check minting status and get NFT hash
app.get('/mint-status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const mintItem = mintQueue.find(item => item.uploadId === uploadId);
  
  if (!mintItem) {
    // Check if it was already completed
    const completedMint = completedMints.find(mint => mint.uploadId === uploadId);
    if (completedMint) {
      res.json({
        success: true,
        status: 'completed',
        uploadId: uploadId,
        nftHash: completedMint.nftHash,
        nftObjectId: completedMint.nftObjectId,
        googleSub: completedMint.googleSub,
        walletAddress: completedMint.walletAddress,
        index: completedMint.index
      });
    } else {
      res.json({ success: false, status: 'not_found' });
    }
  } else {
    res.json({
      success: true,
      status: 'queued',
      uploadId: uploadId,
      googleSub: mintItem.googleSub,
      walletAddress: mintItem.walletAddress,
      index: mintItem.index
    });
  }
});


app.post('/test-compose-fish', async (req, res) => {
  try {
    const { hash, record } = req.body;
    
    if (!hash) {
      return res.status(400).json({ error: 'Missing required body parameter: hash' });
    }

    if (!record) {
      return res.status(400).json({ error: 'Missing required body parameter: record' });
    }

    // Clean the hash of any query parameters that might have been accidentally included
    const cleanHash = hash.split('&')[0];
    
    console.log(`🧪 Testing composeFishImage with hash=${cleanHash} and record:`, record);
    const tmpPath = await composeFishImage(cleanHash, record);
    
    // Read the generated file and send it as a response
    const imageBuffer = fs.readFileSync(tmpPath);
    
    // Clean up the temp file
    fs.unlinkSync(tmpPath);
    
    res.setHeader('Content-Type', 'image/png');
    res.send(imageBuffer);
  } catch (err) {
    console.error('Error in /test-compose-fish:', err);
    res.status(500).json({ 
      error: err.message,
      details: {
        hash: req.body.hash,
        record: req.body.record
      }
    });
  }
});
