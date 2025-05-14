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
  const { playerId, cast } = req.body;
  if (!playerId || !Array.isArray(cast)) {
    return res.status(400).json({ error: 'playerId and cast[] required' });
  }
  // 1) Prevent duplicate *pending* casts
  if (playerCasts.some(c => c.playerId === playerId)) {
    return res
      .status(400)
      .json({ error: 'You already have a pending cast. Wait for that to process.' });
  }
  // 2) Prevent new cast if you haven’t claimed your last catch
  if (unclaimedCatches.some(c => c.playerId === playerId)) {
    return res
      .status(400)
      .json({ error: 'Claim your previous catch before casting again.' });
  }
  // 3) All good — queue the new cast
  playerCasts.push({
    playerId,
    cast,
    depth: pickDepth(),           // assign depth here
    timestamp: new Date().toISOString(),
  });

  res.json({ success: true });
});


app.post('/claim', (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: 'playerId required' });
  const idx = unclaimedCatches.findIndex(c => c.playerId === playerId);
  if (idx < 0) return res.status(404).json({ error: 'No unclaimed catch' });
  const [claimed] = unclaimedCatches.splice(idx, 1);
  res.json({ success: true, claimed });
});



// GET /playercasts → returns the full array
app.get('/playercasts', (req, res) => { res.json(playerCasts);});
app.get('/unclaimed', (_, res) => res.json(unclaimedCatches));
app.get('/history',   (_, res) => res.json(catchHistory));

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
const unclaimedCatches = [];
const catchHistory = [];
let lastPhase = phases[currentPhaseIndex];
let lastEvent = null;

/**
 * Main game loop. Every interval:
 *  - Reads fishDb
 *  - For each pending player cast, picks a random fish
 *  - Records the catch in playerCatches
 *  - Clears playerCasts so players can cast again
 */
async function gameLoop() {
  // 0) pull & clear casts
  const castsToProcess = [...playerCasts];
  playerCasts.length = 0;

  // 1) advance phase
  const prev = phases[currentPhaseIndex];
  currentPhaseIndex = (currentPhaseIndex + 1) % phases.length;
  const phase = phases[currentPhaseIndex];
  lastPhase = phase;
  console.log(`🕰️ ${prev} → ${phase}`);

  // 2) tally & pick event
  const voteCounts = {};
  for (const { cast } of castsToProcess) {
    const t = cast.find(n => events[n]);
    if (t != null) voteCounts[events[t]] = (voteCounts[events[t]] || 0) + 1;
  }
  let chosenEvent = null;
  const entries = Object.entries(voteCounts);
  if (entries.length) {
    const max = Math.max(...entries.map(([,c])=>c));
    const top = entries.filter(([,c])=>c===max).map(([e])=>e);
    chosenEvent = top[Math.floor(Math.random()*top.length)];
  }
  lastEvent = chosenEvent;
  console.log('🎯 votes', voteCounts, '→', chosenEvent);
  

  // 3) catch fish & record with phase/event
  await fishDb.read();
  const fishEntries = Object.entries(fishDb.data.fish);
  for (const { playerId, cast } of castsToProcess) {

    // 3a) pick depth for this cast
    const depth = pickDepth();
    
    // new weighted pick, possibly filtered by feed-hours
    const available = fishEntries.filter(
      ([, stats]) => stats['feed-hours']?.includes(phase)
    );
    // const pick = pickWeighted(available.length ? available : fishEntries);
    const allFishEntries = Object.entries(fishDb.data.fish);
    const pick = selectFishByDepthAndPhase(allFishEntries, depth, phase);
    if (!pick) {
      console.log('No fish available to catch');
      continue;
    }
    const [type, stats] = pick;


    // build the single catch object
    const catchRecord = {
      playerId,                     // if you’re tracking which player caught it
      cast,
      depth,
      catch: { type, stats },
      event: lastEvent,
      phase: lastPhase,
      at: new Date().toISOString(),
    };

    // store it for claiming
    unclaimedCatches.push(catchRecord);
    // store it in the permanent history
    catchHistory.push(catchRecord);

    // 3d) log with depth
    console.log(
      `🎣 [${cast.join(',')}] @ depth "${depth}" → ${type}` +
      (lastEvent ? ` (+${lastEvent})` : '')
    );
  }

  // 4) done
  console.log(`✅ loop done (phase: ${phase})\n`);
}


gameLoop();
setInterval(gameLoop, 30_000);

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
    catches: playerCatches,
  });
});