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
import { db } from './db.js'
import { fishDb } from './fishDb.js'
import { cardsDb } from './cardsDB.js'
import { getBonusesFromCast, applyFishWeightBonuses, applyEventBonuses, applyRarityWeightBonuses, applyBaseFishRateBonus } from './castModifiers.js';
import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import { fileURLToPath } from 'url';
import { Upload } from 'tus-js-client';

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

const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));


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

async function composeFishImage(fishHash, fishName) {
  console.log(`🎨 composing image layers for fishHash=${fishHash}`);

  // 1) fetch fish sprite
  console.log(`➡️  fetching fish from Walrus CDN: ${fishHash}`);
  const fishResp = await fetch(`https://walrus.tusky.io/${fishHash}`);
  if (!fishResp.ok) throw new Error(`Failed to fetch fish layer: ${fishResp.statusText}`);
  const fishBuf = Buffer.from(await fishResp.arrayBuffer());
  console.log(`✅  got ${fishBuf.length} bytes from Walrus/${fishHash}`);

  // 2) fetch background via your proxy
  console.log(`➡️  proxy fetching background via /tusky/${BACKGROUND_FILE_ID}`);
  const bgResp = await fetch(`http://localhost:${PORT}/tusky/${BACKGROUND_FILE_ID}`);
  if (!bgResp.ok) throw new Error(`Proxy download failed (${bgResp.status}): ${bgResp.statusText}`);
  const bgBuf = Buffer.from(await bgResp.arrayBuffer());
  console.log(`✅  got ${bgBuf.length} bytes from proxy/${BACKGROUND_FILE_ID}`);

  // 3) build an SVG label
  const svgLabel = `
    <svg width="2048" height="2048">
      <style>
        .label {
          font-family: sans-serif;
          font-size: 64px;
          fill: white;
          stroke: black;
          stroke-width: 4px;
        }
      </style>
      <text x="40" y="2000" class="label">${fishName}</text>
    </svg>
  `;
  const svgBuffer = Buffer.from(svgLabel);

  // 4) composite everything
  console.log(`🔧 layering background + fish + label...`);
  const finalPng = await sharp(bgBuf)
    .resize(2048, 2048)
    .composite([
      { input: fishBuf, gravity: 'center' },
      { input: svgBuffer, gravity: 'northwest' }
    ])
    .png()
    .toBuffer();

  // 5) write out to temp file
  const tmpPath = path.join(os.tmpdir(), `${fishHash}.png`);
  fs.writeFileSync(tmpPath, finalPng);
  console.log(`💾 composed PNG with label written to ${tmpPath}`);

  return tmpPath;
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
  const maxAttempts = 15;
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

async function mintRandomFishNFT() {
  console.log(`=== mintRandomFishNFT called ===`);

  // 1️⃣ pick a random non-junk fish
  const fishDbRaw = JSON.parse(fs.readFileSync(FISH_JSON, 'utf-8')).fish;
  const keys      = Object.keys(fishDbRaw);
  let choice, data;
  do {
    choice = keys[Math.floor(Math.random() * keys.length)];
    data   = fishDbRaw[choice];
  } while (!data['base-image'] || data['base-image'] === '-');
  console.log(`🐟 selected fish: ${choice} (hash: ${data['base-image']})`);

  // 2️⃣ compose the layered image
  const tmpFile = await composeFishImage(data['base-image'], `${choice}`);
  console.log(`☁️  composed image ready at ${tmpFile}`);

  // 3️⃣ upload it
  console.log(`☁️  uploading composed image to Tusky…`);
  const fileId = await uploadToTusky(tmpFile);
  console.log(`🔗 uploaded, received blobId=${fileId}`);
  const url = `https://walrus.tusky.io/${fileId}`;

  // 4️⃣ mint the NFT on chain
  console.log(`🚀 minting NFT on chain…`);
  const result = await mintNFT({
    name:        choice,
    description: `Layered NFT of a ${choice}`,
    imageUrl:    url,
    thumbnailUrl:url,
  });
  console.log(`🏷️  mint complete, digest=${result.digest}`);

  return {
    type:          choice,
    digest:        result.digest,
    objectChanges: result.objectChanges,
  };
}

app.post('/mint-fish', async (req, res) => {
  console.log('=== /mint-fish called ===');
  try {
    const { type, digest, objectChanges } = await mintRandomFishNFT();
    console.log('=== /mint-fish returning success ===');
    res.json({ success: true, fishType: type, digest, objectChanges });
  } catch (err) {
    console.error('=== /mint-fish error ===', err);
    res.status(500).json({ error: err.message });
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


async function createNewPlayer(id) {
  await db.read();
  const defaultState = {
    activeHand: [-1,-1,-1],
    hand:      await generateRandomDeck(3),
    deckCount: 20,
    deck:      await generateRandomDeck(20),
    resetDeck: true,
    madness:   0,
    state:     1,
    casts:     0,
    catch:     null
  };
  db.data.players[id] = defaultState;
  await db.write();
  return defaultState;
}

// POST /player/init → ensure a player exists, return their state
app.post('/player/init', async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) {
    return res.status(400).json({ error: 'playerId required' });
  }
  await db.read();
  const players = db.data.players;

  // if they don't exist yet, create them
  if (!players[playerId]) {
    const newState = await createNewPlayer(playerId);
    return res.json({ playerId, state: newState, created: true });
  }

  // otherwise just return the existing state
  return res.json({ playerId, state: players[playerId], created: false });
});

app.get('/players', async (req, res) => {
  await db.read();
  res.json(db.data.players);
});

// -- DB -- //
app.get('/player/:id', async (req, res) => {
  await db.read();
  const id = req.params.id;
  const player = db.data.players[id];

  if (!player) {
    return res
      .status(404)
      .json({ error: `Player "${id}" not found.` });
  }

  res.json({ id, state: player });
});


// Update a player's state
app.post('/player/:id', async (req, res) => {
  await db.read()
  const id = req.params.id
  const players = db.data.players

  // merge whatever you send in { wins, plays, … }
  players[id] = { ...(players[id] || {}), ...req.body }
  await db.write()

  res.json({ id, state: players[id] })
})

/**
 * GET /player-info/:playerId
 * Returns the full player object (hand, deck, state, etc.)
 */
app.get('/player-info/:playerId', async (req, res) => {
  const { playerId } = req.params;
  if (!playerId) {
    return res.status(400).json({ error: 'playerId required' });
  }

  await db.read();
  const player = db.data.players[playerId];
  if (!player) {
    return res.status(404).json({ error: `Player "${playerId}" not found.` });
  }

  return res.json({ playerId, ...player });
});

/**
 * POST /players/refill-decks
 * Re‐deals every player:
 *  • a fresh 20‐card `deck`
 *  • a fresh  3‐card `hand`
 */
app.post('/players/refill-decks', async (req, res) => {
  // 1) Reload card pool & players DB
  await cardsDb.read();
  await db.read();

  const players = db.data.players;
  for (const playerId of Object.keys(players)) {
    // brand-new deck of 20
    const newDeck = await generateRandomDeck(20);
    players[playerId].deck      = newDeck;
    players[playerId].deckCount = newDeck.length;

    // brand-new hand of 3
    const newHand = await generateRandomDeck(3);
    players[playerId].hand = newHand;
  }

  // 2) Persist in one shot
  await db.write();

  // 3) Return updated map
  res.json({ success: true, players });
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
async function generateRandomDeck(size = 20) {
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
  const { playerId, cast } = req.body;

  // 0) Basic validation
  if (!playerId || !Array.isArray(cast)) {
    return res.status(400).json({ error: 'playerId and cast[] required' });
  }

  // 0.5) Ensure the player exists
  await db.read();
  const player = db.data.players[playerId];
  if (!player) {
    return res.status(400).json({ error: `Player "${playerId}" not found.` });
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
  if (playerCasts.some(c => c.playerId === playerId)) {
    return res.status(400).json({ error: 'You already have a pending cast.' });
  }

  // 2) Prevent new cast if unclaimed still exist
  if (unclaimedCatches.some(c => c.playerId === playerId)) {
    return res.status(400).json({ error: 'Claim your previous catch first.' });
  }

  // 3) Queue the cast
  const bonuses = getBonusesFromCast(cast);
  const record = {
    playerId,
    cast,
    depth: pickDepth(),
    bonuses,
    timestamp: new Date().toISOString(),
  };
  playerCasts.push(record);

  // 4) Draw replacements for each used card
  for (let i = 0; i < cast.length; i++) {
    if (cast[i] > -1) {
      if (player.deck.length > 0) {
        const drawPos   = Math.floor(Math.random() * player.deck.length);
        const [newCard] = player.deck.splice(drawPos, 1);
        player.hand[i]  = newCard;
      } else {
        // no more cards in deck → clear that slot
        player.hand[i] = -1;
      }
    }
  }
  // update deckCount
  player.deckCount = player.deck.length;

  // 5) Flip state → 2, persist, etc.
  player.state = 2;
  await db.write();

  return res.json({
    success:   true,
    newHand:   player.hand,
    deckCount: player.deckCount
  });
});


app.post('/claim', async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) {
    return res.status(400).json({ error: 'playerId required' });
  }

  // find and remove from in-memory unclaimedCatches
  const idx = unclaimedCatches.findIndex(c => c.playerId === playerId);
  if (idx < 0) {
    return res.status(404).json({ error: 'No unclaimed catch' });
  }
  const [claimed] = unclaimedCatches.splice(idx, 1);

  // update player record: reset state → 1 and remove the saved catch
  await db.read();
  const player = db.data.players[playerId];
  if (player) {
    player.state = 1;
    delete player.catch;
    await db.write();
  }

  return res.json({ success: true, claimed });
});


// GET /playercasts → returns the full array
app.get('/playercasts', (req, res) => { res.json(playerCasts);});
app.get('/unclaimed', (_, res) => res.json(unclaimedCatches));
app.get('/history', (_, res) => res.json(catchHistory))

// ─── at top of your file, alongside other in-memory stores ───
const phases = ['dawn', 'day', 'dusk', 'night'];
let currentPhaseIndex = 0; // start at 'dawn'
let currentHour = 0;
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

  console.log(`🕰️ Hour ${currentHourSnapshot} (Phase ${currentPhaseSnapshot} ${currentPhaseHour}/6)`);
  console.log(`🎯 event: ${currentEvent || 'none'}`);

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
  const breakdown = pool.reduce((acc, f) => {
    acc[f.type] = (acc[f.type] || 0) + 1;
    return acc;
  }, {});
  printPoolBreakdown(breakdown, fishDb.data.fish);

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
      console.warn(`⚠️ No fish in personal pool for ${rec.playerId}, skipping…`);
      continue;
    }

    const r      = Math.random() * totalWeight;
    const winner = cumulative.find(e => r < e.threshold) || cumulative[cumulative.length - 1];
    console.log(`🎲 draw ${r.toFixed(2)} / ${totalWeight.toFixed(2)} → ${winner.type}`);

    const metrics = rollFishMetrics(winner.stats);

    // assemble the catch record
    const catchRecord = {
      playerId: rec.playerId,
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
        playerId: catchRecord.playerId,
        type:     catchRecord.catch.type,
        at:       catchRecord.at,
        weight:   catchRecord.weight,
        length:   catchRecord.length,
      });
    }

    // enqueue for later claiming
    unclaimedCatches.push(catchRecord);

    await recordCatchHistory(catchRecord);

      // mark player as "has a catch to claim"
      await db.read();
      if (db.data.players[rec.playerId]) {
        db.data.players[rec.playerId].state = 3;
        db.data.players[rec.playerId].catch = {
          type:   catchRecord.catch.type,
          at:     catchRecord.at,
          weight: catchRecord.weight,
          length: catchRecord.length
        }; // Cache catch
        await db.write();
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
    console.log(`⏩ Phase: ${oldPhase} → ${lastPhase}`);
  }

   // ✨ when we wrap back to hour 0, reset every player's deck
   if (currentHour === 0) {
    console.log("🌑 It's dawn—resetting all player decks and hands");
    await cardsDb.read();
    await db.read();

    for (const playerId of Object.keys(db.data.players)) {
      const player = db.data.players[playerId];

      // brand-new deck of 20
      const newDeck = await generateRandomDeck(20);
      player.deck      = newDeck;
      player.deckCount = newDeck.length;

      // brand-new hand of 3
      const newHand = await generateRandomDeck(3);
      player.hand = newHand;

      // // reset their activeHand slots
      // player.activeHand = [-1, -1, -1];

      // // optionally reset state back to "can cast" (1)
      // player.state = 1;
    }

    await db.write();
  }

  console.log(`✅ gameLoop complete\n--------------------------------\n`);
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
  res.json({
    phase: lastPhase,
    event: lastEvent,
    hour: currentHour,
    catches: playerCatches,
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

  console.log(`🎯 Pool breakdown (${Object.values(breakdown).reduce((a,b)=>a+b,0)}):`);
  for (const [type, count] of Object.entries(breakdown)) {
    const stats = fishIndex[type] || {};
    const rarity = stats.rarity || 'common';
    const color = C[rarity] || C.common;
    console.log(`${color}  • ${type}: ${count}${C.reset}`);
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
    `${catchRecord.playerId}: ${catchRecord.catch.type}` +
    `${weightSegment}` +
    `${eventSegment} @${time}`;

  // in-memory history
  catchHistory.push(line);

  // on-disk history
  catchDb.data.history.push(line);
  await catchDb.write();

  // console log
  console.log(`🎣 ${catchRecord.playerId} caught ${catchRecord.catch.type}${weightSegment}`);
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
app.get('/fish-catches/:playerId', (req, res) => {
  const { playerId } = req.params;
  const matches = fishCatchesData.filter(c => c.playerId === playerId);
  res.json(matches);
});

// 1️⃣ Helper: mints the caught fish NFT for a player→recipient
async function mintCaughtFishNFTFor(playerId, recipient) {
  // find the first un-minted catch
  const rec = fishCatchesData.find(c => c.playerId === playerId);
  if (!rec) {
    throw new Error(`No caught fish found for player "${playerId}"`);
  }

  // compose & upload
  const tmp    = await composeFishImage(rec.catch.stats['base-image']);
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

app.post('/mint-caught-fish', async (req, res) => {
  const { recipient } = req.body;
  if (!recipient) {
    return res.status(400).json({ error: 'recipient address required' });
  }

  try {
    // 1) pick a random non-junk fish from fish.json
    const fishIndex = JSON.parse(fs.readFileSync(FISH_JSON, 'utf-8')).fish;
    const types = Object.keys(fishIndex).filter(
      t => fishIndex[t]['base-image'] && fishIndex[t]['base-image'] !== '-'
    );
    const choice = types[Math.floor(Math.random() * types.length)];
    const hash   = fishIndex[choice]['base-image'];
    console.log(`🐟 picked ${choice} for ${recipient} (hash=${hash})`);

    // 2) compose + upload just like before
    const tmp = await composeFishImage(hash);
    const blobId = await uploadToTusky(tmp);
    const url    = `https://walrus.tusky.io/${blobId}`;
    console.log(`🔗 uploaded composed image → ${blobId}`);

    // 3) mint to their address
    console.log(`🚀 minting "${choice}" to ${recipient}…`);
    const result = await mintNFTTo({
      recipient,
      name:        choice,
      description: `Layered NFT of a ${choice}`,
      imageUrl:    url,
      thumbnailUrl:url,
    });
    console.log(`🏷️ minted, digest=${result.digest}`);

    res.json({
      success: true,
      fishType: choice,
      digest: result.digest,
      objectChanges: result.objectChanges,
    });
  } catch (e) {
    console.error('/mint-caught-fish error', e);
    res.status(500).json({ error: e.message });
  }
});