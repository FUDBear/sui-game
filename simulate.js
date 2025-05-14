// node simulate.js
import fs from 'fs';
import path from 'path';

// 1) Load fish.json
const file = path.join(process.cwd(), 'fish.json');
const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
const fishData = data.fish;

// 2) Define phases
const phases = ['dawn', 'day', 'dusk', 'night'];

// 3) Weighted picker with feed-hours filtering
function pickFish(phase) {
  let entries = Object.entries(fishData)
    .filter(([, stats]) =>
      Array.isArray(stats['feed-hours']) &&
      stats['feed-hours'].includes(phase)
    );
  if (!entries.length) entries = Object.entries(fishData);

  // build cumulative weights
  let totalWeight = 0;
  const cum = [];
  for (const [type, stats] of entries) {
    const w = Number(stats['base-catch-rate'] || 0);
    if (w <= 0) continue;
    totalWeight += w;
    cum.push({ threshold: totalWeight, type });
  }
  if (!totalWeight) return null;

  const r = Math.random() * totalWeight;
  for (const { threshold, type } of cum) {
    if (r < threshold) return type;
  }
  return cum[cum.length - 1].type;
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

// 5) Simulate
const SIMS = 1000;
const fishCounts  = Object.fromEntries(Object.keys(fishData).map(t => [t,0]));
const depthCounts = { shoals:0, shelf:0, dropoff:0, canyon:0, abyss:0 };

for (let i = 0; i < SIMS; i++) {
  const phase = phases[Math.floor(Math.random()*phases.length)];
  const depth = pickDepth();
  depthCounts[depth]++;

  const caught = pickFish(phase);
  if (caught) fishCounts[caught]++;
}

// 6) Output results
console.log(`\nSimulated ${SIMS} casts\n`);

console.log('🐟 Fish catch distribution:');
for (const [type, count] of Object.entries(fishCounts)) {
  console.log(`  ${type.padEnd(20)} ${count.toString().padStart(4)} (${(count/SIMS*100).toFixed(2)}%)`);
}

console.log('\n🌊 Depth tier distribution:');
for (const [tier, count] of Object.entries(depthCounts)) {
  console.log(`  ${tier.padEnd(8)} ${count.toString().padStart(4)} (${(count/SIMS*100).toFixed(2)}%)`);
}