// index.js
import express from 'express';
import dotenv from 'dotenv';
import { client, address, mintNFT, callRewardWinner } from './suiClient.js';
import { db } from './db.js'
import { fishDb } from './fishDb.js'
import cors from 'cors';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

// Health‐check endpoint
app.get('/ping', (_, res) => {
  res.json({ pong: true });
});

app.get('/balance', async (_, res) => {
  try {
    const { totalBalance } = await client.getBalance({ owner: address }); // BigInt
    const balanceSui = Number(totalBalance) / 1e9;  // mist → SUI
    res.json({ address, balanceSui });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /play → roll & call Move on win
app.post('/play', async (_, res) => {
  const roll = Math.floor(Math.random() * 26);
  const win  = roll > 22;

  if (!win) {
    return res.json({ win: false, roll });
  }

  try {
    const tx = await callRewardWinner();
    res.json({
      win: true,
      roll,
      txDigest: tx.digest,
      effects: tx.effects,
      events: tx.events,
    });
  } catch (err) {
    console.error('Contract call failed:', err);
    res.status(500).json({ error: err.message });
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

app.get('/players', async (req, res) => {
  await db.read();
  res.json(db.data.players);
});

// -- DB -- //
app.get('/player/:id', async (req, res) => {
  await db.read()
  const id = req.params.id
  const players = db.data.players

  // initialize an empty state if first time
  if (!players[id]) {
    players[id] = { wins: 0, plays: 0 }
    await db.write()
  }

  res.json({ id, state: players[id] })
})

// Update a player’s state
app.post('/player/:id', async (req, res) => {
  await db.read()
  const id = req.params.id
  const players = db.data.players

  // merge whatever you send in { wins, plays, … }
  players[id] = { ...(players[id] || {}), ...req.body }
  await db.write()

  res.json({ id, state: players[id] })
})

// --- New Fish routes ---

// GET all fish types & stats
app.get('/fish', async (req, res) => {
  await fishDb.read()
  res.json(fishDb.data.fish)
})

// GET a single fish by key (e.g. “salmon”)
app.get('/fish/:type', async (req, res) => {
  await fishDb.read()
  const f = fishDb.data.fish[req.params.type]
  if (!f) return res.status(404).send()
  res.json({ type: req.params.type, stats: f })
})

// -- fish loop
// const spawnedFish = [];

// // helper to pick a random fish and store it
// async function spawnRandomFish() {
//   await fishDb.read(); // reload fish.json
//   const entries = Object.entries(fishDb.data.fish);
//   if (entries.length === 0) return;
//   const [type, stats] = entries[Math.floor(Math.random() * entries.length)];
//   spawnedFish.push({
//     type,
//     stats,
//     spawnedAt: new Date().toISOString(),
//   });
//   console.log(`🪝 Spawned fish: ${type}`);
// }

// // spawn one immediately, then every 30 seconds
// spawnRandomFish();
// setInterval(spawnRandomFish, 30_000);

// // endpoint to fetch the array of spawned fish
// app.get('/spawned-fish', (req, res) => {
//   res.json(spawnedFish);
// });

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

app.post('/playercast', (req, res) => {
  try {
    const { cast } = req.body;
    playercast(cast);
    return res.json({ success: true, cast });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// GET /playercasts → returns the full array
app.get('/playercasts', (req, res) => {
  res.json(playerCasts);
});

// ─── at top of your file, alongside other in‐memory stores ───
const phases = ['dawn', 'day', 'dusk', 'night'];
let currentPhaseIndex = 0; // start at 'dawn'
const events = {
  10: 'blood',
  11: 'nightmare',
  12: 'toxic',
  13: 'frozen',
};
const playerCatches = [];

/**
 * Main game loop. Every interval:
 *  - Reads fishDb
 *  - For each pending player cast, picks a random fish
 *  - Records the catch in playerCatches
 *  - Clears playerCasts so players can cast again
 */
async function gameLoop() {
  // 0) Grab & clear pending casts before processing
  const castsToProcess = [...playerCasts];
  playerCasts.length = 0;

  // 1) Phase advance
  const prevPhase = phases[currentPhaseIndex];
  currentPhaseIndex = (currentPhaseIndex + 1) % phases.length;
  const phase = phases[currentPhaseIndex];
  console.log(`🕰️ Phase change: ${prevPhase} → ${phase}`);

  // 2) Tally votes for any event‐triggering casts
  const voteCounts = {};
  for (const { cast } of castsToProcess) {
    const trigger = cast.find(n => events[n]);
    if (trigger != null) {
      const name = events[trigger];
      voteCounts[name] = (voteCounts[name] || 0) + 1;
    }
  }

  // 3) Choose the winning event (or null)
  let chosenEvent = null;
  const entries = Object.entries(voteCounts);
  if (entries.length) {
    // find max vote count
    const maxVotes = Math.max(...entries.map(([,count])=>count));
    // filter to events with that count
    const topEvents = entries
      .filter(([,count]) => count === maxVotes)
      .map(([name]) => name);
    // if tie, pick randomly
    chosenEvent = topEvents[Math.floor(Math.random() * topEvents.length)];
  }
  console.log('🎯 Event votes:', voteCounts, '→ chosen:', chosenEvent);

  // 4) Reload fish data for catches
  await fishDb.read();
  const fishEntries = Object.entries(fishDb.data.fish);
  if (!fishEntries.length) {
    console.log('🎣 No fish to catch this turn');
  }

  // 5) Process each cast into a catch
  for (const { cast } of castsToProcess) {
    // pick a random fish
    const [type, stats] =
      fishEntries[Math.floor(Math.random() * fishEntries.length)];

    playerCatches.push({
      cast,
      catch: { type, stats },
      event: chosenEvent,          // same event for everybody this turn
      phase,
      at: new Date().toISOString(),
    });

    console.log(
      `🎣 [${cast.join(',')}] → ${type}` +
      (chosenEvent ? ` + event "${chosenEvent}"` : '')
    );
  }

  console.log(`✅ gameLoop complete (phase: ${phase})\n`);
}

// kick it off & schedule every 30s
gameLoop();
setInterval(gameLoop, 30_000);

// (Optional) expose an endpoint to inspect past catches:
app.get('/catches', (req, res) => {
  res.json(playerCatches);
});