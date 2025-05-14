// castModifiers.js
// Centralized card-based cast modifiers in plain JS with JSDoc types

import { cardsDb } from './cardsDB.js';
await cardsDb.read();

/**
 * @typedef {Object} ForceDepthBonus
 * @property {'forceDepth'} type
 * @property {string} depth
 *
 * @typedef {Object} GlobalFishWeightBonus
 * @property {'globalFishWeight'} type
 * @property {number} multiplier
 *
 * @typedef {Object} FishWeightBonus
 * @property {'fishWeight'} type
 * @property {string} fishType
 * @property {number} multiplier
 *
 * @typedef {Object} EventVoteBonus
 * @property {'eventVote'} type
 * @property {string} event
 * @property {number} votes
 *
 * @typedef {ForceDepthBonus | GlobalFishWeightBonus | FishWeightBonus | EventVoteBonus} Bonus
 */

/**
 * Given an array of card names, return a flat list of bonuses
 * @param {string[]} cardNames
 * @returns {Bonus[]}
 */
export function getBonusesFromCards(cardNames) {
  /** @type {Bonus[]} */
  const bonuses = [];

  for (const name of cardNames) {
    const card = cardsDb.data.cards[name];
    if (!card) continue;

    if (card['depth-force']) {
      bonuses.push({ type: 'forceDepth', depth: card['depth-force'] });
    }

    if (card['fish-weight'] && card['fish-weight'] !== 1) {
      bonuses.push({ type: 'globalFishWeight', multiplier: card['fish-weight'] });
    }

    if (Array.isArray(card['attract-type']) && card['attract-weight']) {
      for (const ft of card['attract-type']) {
        bonuses.push({ type: 'fishWeight', fishType: ft, multiplier: card['attract-weight'] });
      }
    }

    if (Array.isArray(card['force-event'])) {
      for (const ev of card['force-event']) {
        bonuses.push({ type: 'eventVote', event: ev, votes: 1 });
      }
    }
  }

  return bonuses;
}

/**
 * Override a depth if a forceDepth bonus exists
 * @param {string} originalDepth
 * @param {Bonus[]} bonuses
 * @returns {string}
 */
export function applyDepthBonuses(originalDepth, bonuses) {
  const forced = bonuses.find(b => b.type === 'forceDepth');
  return forced ? forced.depth : originalDepth;
}

/**
 * Apply global and per-fish weight multipliers to a catch pickList
 * @param {[string, any][]} pickList
 * @param {Bonus[]} bonuses
 * @returns {[string, any][]}
 */
export function applyFishWeightBonuses(pickList, bonuses) {
  const globalMult = bonuses
    .filter(b => b.type === 'globalFishWeight')
    .reduce((m, b) => m * b.multiplier, 1);

  const fishMults = bonuses
    .filter(b => b.type === 'fishWeight')
    .reduce((map, b) => {
      map[b.fishType] = (map[b.fishType] || 1) * b.multiplier;
      return map;
    }, {});

  return pickList.map(([type, stats]) => {
    const base = Number(stats['base-catch-rate'] || 0);
    const w = base * globalMult * (fishMults[type] || 1);
    return [type, { ...stats, 'base-catch-rate': w }];
  });
}

/**
 * Add extra event votes into the voteCounts object
 * @param {{[event: string]: number}} voteCounts
 * @param {Bonus[]} bonuses
 */
export function applyEventBonuses(voteCounts, bonuses) {
  bonuses
    .filter(b => b.type === 'eventVote')
    .forEach(b => {
      voteCounts[b.event] = (voteCounts[b.event] || 0) + b.votes;
    });
}

/**
 * Given the raw cast array of numbers, pull matching cards by index
 * and return combined bonuses.
 * @param {number[]} cast
 * @returns {Bonus[]}
 */
export function getBonusesFromCast(cast) {
  /** @type {string[]} */
  const cardNames = [];

  // Build index→name map
  const idxMap = new Map();
  for (const [name, card] of Object.entries(cardsDb.data.cards)) {
    if (typeof card.index === 'number') {
      idxMap.set(card.index, name);
    }
  }

  // Collect unique names
  for (const n of cast) {
    const nm = idxMap.get(n);
    if (nm && !cardNames.includes(nm)) cardNames.push(nm);
  }

  return getBonusesFromCards(cardNames);
}
