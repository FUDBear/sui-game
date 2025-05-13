// node applyTemplate.js  
import fs from 'fs';

// 1) Load your fish.json
const path = './fish.json';
const raw = fs.readFileSync(path, 'utf-8');
const data = JSON.parse(raw);

// 2) Grab the Murkgill template
const template = data.fish.Murkgill;

// 3) Apply to every other fish
for (const [name, info] of Object.entries(data.fish)) {
  if (name === 'Murkgill') continue;

  // If you want to preserve each fish’s original rarity, uncomment the next line:
  // const originalRarity = info.rarity;

  data.fish[name] = {
    // copy every field from Murkgill
    ...template,
    // clear out the event-variations array
    'event-variations': [],
    // (optional) restore the fish’s original rarity:
    // rarity: originalRarity,
  };
}

// 4) Write the updated JSON back
fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('✅ Applied Murkgill template to all fish (event-variations emptied).');
