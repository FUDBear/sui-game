// node simulate.js
// Simulate 1,000 casts with full game logic (card bonuses, events, catch rates, etc.)

import {
  getBonusesFromCast,
  applyEventBonuses,
  applyFishWeightBonuses,
  applyRarityWeightBonuses,
  applyBaseFishRateBonus
} from './castModifiers.js';

import { cardsDb } from './cardsDB.js';
import { fishDb }  from './fishDb.js';

await cardsDb.read();
await fishDb.read();

const fishData = fishDb.data.fish;

// 1) Phase list & weighted depth picker
const phases = ['dawn','day','dusk','night'];
function pickDepth() {
  const weights = { shoals:80, shelf:50, dropoff:20, canyon:5, abyss:0.1 };
  let total = 0, cum = [];
  for (const [tier,w] of Object.entries(weights)) {
    total += w;
    cum.push({ threshold: total, tier });
  }
  const r = Math.random() * total;
  return cum.find(e => r < e.threshold).tier;
}

// 2) Helper: weighted pick from [type,stats] list
function pickWeighted(list) {
  let total = 0, cum = [];
  for (const [type,stats] of list) {
    const w = Number(stats['base-catch-rate']||0);
    if (w > 0) {
      total += w;
      cum.push({ threshold: total, type, stats });
    }
  }
  if (total === 0) return null;
  const r = Math.random() * total;
  return cum.find(e => r < e.threshold) ?? cum[cum.length-1];
}

// 3) Active‐fish filter (feed‐hours + only‐active‐events)
function isFishCurrentlyActive(stats, phase, chosenEvent) {
  if (!Array.isArray(stats['feed-hours']) ||
      !stats['feed-hours'].includes(phase)) return false;
  if (Array.isArray(stats['only-active-events']) &&
      stats['only-active-events'].length > 0) {
    return chosenEvent != null &&
           stats['only-active-events'].includes(chosenEvent);
  }
  return true;
}

// 4) Gather all card‐indices for random hand draws
const allCardIndices = Object.values(cardsDb.data.cards)
  .filter(c => typeof c.index === 'number')
  .map(c => c.index);

// 5) Simulation counters
const SIMS = 1000;
const fishCounts  = Object.fromEntries(Object.keys(fishData).map(t=>[t,0]));
const depthCounts = { shoals:0, shelf:0, dropoff:0, canyon:0, abyss:0 };
const phaseCounts = Object.fromEntries(phases.map(p=>[p,0]));
const eventCounts = {};

for (let i = 0; i < SIMS; i++) {
  // — pick a random phase
  const phase = phases[Math.floor(Math.random() * phases.length)];
  phaseCounts[phase]++;

  // — pick 3 random cards
  const cast = Array.from({length:3}, () =>
    allCardIndices[Math.floor(Math.random() * allCardIndices.length)]
  );

  // — compute card bonuses
  const bonuses = getBonusesFromCast(cast);

  // — depth (no applyDepthBonuses anymore)
  const depth = pickDepth();
  depthCounts[depth]++;

  // — event voting
  const voteCounts = {};
  applyEventBonuses(voteCounts, bonuses);
  let chosenEvent = null;
  if (Object.keys(voteCounts).length) {
    const entries = Object.entries(voteCounts);
    const max = Math.max(...entries.map(([,c]) => c));
    const top = entries.filter(([,c]) => c === max).map(([e]) => e);
    chosenEvent = top[Math.floor(Math.random() * top.length)];
    eventCounts[chosenEvent] = (eventCounts[chosenEvent] || 0) + 1;
  }

  // — build the catch pool
  let pickList = Object.entries(fishData)
    .filter(([,stats]) => isFishCurrentlyActive(stats, phase, chosenEvent))
    .map(([type,stats]) => {
      let rate = Number(stats['base-catch-rate']||0);
      if (chosenEvent && Array.isArray(stats['event-variations'])) {
        const ev = stats['event-variations'].find(x=>x.event===chosenEvent);
        if (ev?.multiplier) rate *= ev.multiplier;
      }
      return [type, {...stats, 'base-catch-rate': rate}];
    });

  // — apply all other card‐based modifiers
  pickList = applyFishWeightBonuses(pickList, bonuses);
  pickList = applyRarityWeightBonuses(pickList, bonuses);
  pickList = applyBaseFishRateBonus(pickList, bonuses);

  // — final draw
  const winner = pickWeighted(pickList);
  if (winner) fishCounts[winner.type]++;
}

// 6) Print results
console.log(`\nSimulated ${SIMS} casts with random 3‐card draws\n`);
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
