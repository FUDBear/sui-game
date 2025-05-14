// node simulate.js
// simulate.js
// Simulate casts using depth, phase, feed-hours, and weighted fish selection

import fs from 'fs';
import path from 'path';

// 1) Load fish.json
const file = path.join(process.cwd(), 'fish.json');
const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
const fishData = data.fish;

// 2) Define phases and depth tiers
const phases = ['dawn', 'day', 'dusk', 'night'];

// 3) Weighted picker helper
function pickWeighted(entries) {
  let total = 0;
  const cum = [];
  for (const [type, stats] of entries) {
    const w = Number(stats['base-catch-rate'] || 0);
    if (w > 0) {
      total += w;
      cum.push({ threshold: total, type, stats });
    }
  }
  if (total === 0) return null;
  const r = Math.random() * total;
  for (const { threshold, type, stats } of cum) {
    if (r < threshold) return [type, stats];
  }
  const last = cum[cum.length - 1];
  return [last.type, last.stats];
}

// 4) Depth picker
function pickDepth() {
  const weights = { shoals: 80, shelf: 50, dropoff: 20, canyon: 5, abyss: 0.1 };
  let total = 0;
  const cum = [];
  for (const [tier, w] of Object.entries(weights)) {
    total += w;
    cum.push({ threshold: total, tier });
  }
  const r = Math.random() * total;
  for (const { threshold, tier } of cum) {
    if (r < threshold) return tier;
  }
  return cum[cum.length - 1].tier;
}

// 5) Combined selection: filter by depth & phase, then weighted pick
function selectFishByDepthAndPhase(depth, phase) {
  const allEntries = Object.entries(fishData);
  // filter by fish.depths array
  const depthFiltered = allEntries.filter(([, stats]) =>
    Array.isArray(stats.depths) && stats.depths.includes(depth)
  );
  if (!depthFiltered.length) return null;
  // filter by feed-hours for current phase
  const feedFiltered = depthFiltered.filter(([, stats]) =>
    Array.isArray(stats['feed-hours']) && stats['feed-hours'].includes(phase)
  );
  const pickList = feedFiltered.length ? feedFiltered : depthFiltered;
  return pickWeighted(pickList);
}

// 6) Simulation
const SIMS = 1000;
const fishCounts = Object.keys(fishData).reduce((acc, t) => ({ ...acc, [t]: 0 }), {});
const depthCounts = { shoals: 0, shelf: 0, dropoff: 0, canyon: 0, abyss: 0 };
const phaseCounts = phases.reduce((acc, p) => ({ ...acc, [p]: 0 }), {});

for (let i = 0; i < SIMS; i++) {
  const phase = phases[Math.floor(Math.random() * phases.length)];
  phaseCounts[phase]++;

  const depth = pickDepth();
  depthCounts[depth]++;

  const pick = selectFishByDepthAndPhase(depth, phase);
  if (pick) {
    const [type] = pick;
    fishCounts[type]++;
  }
}

// 7) Output results
console.log(`\nSimulated ${SIMS} casts`);

console.log('\nPhase distribution:');
for (const [p, c] of Object.entries(phaseCounts)) {
  console.log(`  ${p.padEnd(6)}: ${c.toString().padStart(4)} (${(c / SIMS * 100).toFixed(2)}%)`);
}

console.log('\nDepth distribution:');
for (const [d, c] of Object.entries(depthCounts)) {
  console.log(`  ${d.padEnd(8)}: ${c.toString().padStart(4)} (${(c / SIMS * 100).toFixed(2)}%)`);
}

console.log('\nFish catch distribution:');
for (const [type, count] of Object.entries(fishCounts)) {
  console.log(`  ${type.padEnd(20)}: ${count.toString().padStart(4)} (${(count / SIMS * 100).toFixed(2)}%)`);
}
