// node simulate.js
// Simulate 1,000 casts with full game logic (depth‐force, events, card bonuses, etc.)

import fs   from 'fs';
import path from 'path';

import {
  getBonusesFromCast,
  applyDepthBonuses,
  applyEventBonuses,
  applyFishWeightBonuses,
  applyRarityWeightBonuses,
  applyBaseFishRateBonus
} from './castModifiers.js';      // assumes this already did `await cardsDb.read()`

import { cardsDb } from './cardsDB.js';
await cardsDb.read();

// 1) Load fish.json
const fishFile = path.join(process.cwd(), 'fish.json');
const fishData = JSON.parse(fs.readFileSync(fishFile, 'utf-8')).fish;

// 2) Phase list & weighted depth picker
const phases = ['dawn','day','dusk','night'];
function pickDepth() {
  const weights = { shoals:80, shelf:50, dropoff:20, canyon:5, abyss:0.1 };
  let total = 0;
  const cum = [];
  for (const [tier,w] of Object.entries(weights)) {
    total += w;
    cum.push({ threshold: total, tier });
  }
  const r = Math.random()*total;
  return cum.find(e=>r<e.threshold).tier;
}

// 3) Helper: weighted pick from [type,stats] list
function pickWeighted(list) {
  let total = 0;
  const cum = [];
  for (const [type,stats] of list) {
    const w = Number(stats['base-catch-rate']||0);
    if (w>0) {
      total += w;
      cum.push({ threshold: total, type, stats });
    }
  }
  if (total === 0) return null;
  const r = Math.random()*total;
  return cum.find(e=>r<e.threshold) ?? cum[cum.length-1];
}

// 4) Active‐fish filter (feed‐hours + only‐active‐events)
function isFishCurrentlyActive(stats, phase, chosenEvent) {
  if (!Array.isArray(stats['feed-hours']) ||
      !stats['feed-hours'].includes(phase)) {
    return false;
  }
  if (Array.isArray(stats['only-active-events']) &&
      stats['only-active-events'].length > 0) {
    return chosenEvent != null &&
           stats['only-active-events'].includes(chosenEvent);
  }
  return true;
}

// 5) Collect all card indices for random draws
const allCardIndices = Object.values(cardsDb.data.cards)
  .filter(c=>typeof c.index === 'number')
  .map(c=>c.index);

// 6) Simulation counters
const SIMS = 1000;
const fishCounts  = Object.fromEntries(Object.keys(fishData).map(t=>[t,0]));
const depthCounts = { shoals:0, shelf:0, dropoff:0, canyon:0, abyss:0 };
const phaseCounts = Object.fromEntries(phases.map(p=>[p,0]));
const eventCounts = {};

for (let i=0; i<SIMS; i++) {
  // — pick phase
  const phase = phases[Math.floor(Math.random()*phases.length)];
  phaseCounts[phase]++;

  // — pick 3 random cards
  const cast = Array.from({length:3},_=>
    allCardIndices[Math.floor(Math.random()*allCardIndices.length)]
  );

  // — compute bonuses
  const bonuses = getBonusesFromCast(cast);

  // — depth (with forceDepth override)
  const baseDepth = pickDepth();
  const depth     = applyDepthBonuses(baseDepth, bonuses);
  depthCounts[depth]++;

  // — event voting
  const voteCounts = {};
  applyEventBonuses(voteCounts, bonuses);
  let chosenEvent = null;
  if (Object.keys(voteCounts).length) {
    const entries = Object.entries(voteCounts);
    const max = Math.max(...entries.map(([,c])=>c));
    const top = entries.filter(([,c])=>c===max).map(([e])=>e);
    chosenEvent = top[Math.floor(Math.random()*top.length)];
    eventCounts[chosenEvent] = (eventCounts[chosenEvent]||0) + 1;
  }

  // — build fish pickList: filter by feed‐hours & only‐active‐events
  const pickList = Object.entries(fishData)
    .filter(([,s]) => isFishCurrentlyActive(s, phase, chosenEvent))
    .map(([type,stats]) => {
      // apply event-variations multipliers
      let rate = Number(stats['base-catch-rate']||0);
      if (chosenEvent && Array.isArray(stats['event-variations'])) {
        const ev = stats['event-variations'].find(x=>x.event===chosenEvent);
        if (ev?.multiplier) rate *= ev.multiplier;
      }
      return [type, {...stats, 'base-catch-rate': rate}];
    });

  // — apply all card‐based modifiers
  let modified = applyFishWeightBonuses(pickList, bonuses);
  modified = applyRarityWeightBonuses(modified, bonuses);
  modified = applyBaseFishRateBonus(modified, bonuses);

  // — final draw
  const winner = pickWeighted(modified);
  if (winner) fishCounts[winner.type]++;

} // end sims loop

// 7) Print summary
console.log(`\nSimulated ${SIMS} casts with random 3-card casts\n`);
console.log('Phase distribution:', phaseCounts);
console.log('Depth distribution:', depthCounts);
console.log('Event distribution:', eventCounts);
console.log('\nFish catch distribution:');
for (const [fish, count] of Object.entries(fishCounts)) {
  console.log(
    `  ${fish.padEnd(20)}: ${count.toString().padStart(4)} `
  + `(${(count/SIMS*100).toFixed(2)}%)`
  );
}
