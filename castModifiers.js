// Centralized card-based cast modifiers in plain JS with JSDoc types

import { cardsDb } from './cardsDB.js';
await cardsDb.read();

/**
 * @typedef {Object} RarityWeightBonus
 * @property {'rarityWeight'} type
 * @property {string} rarity
 * @property {number} multiplier
 *
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
 * @typedef {Object} RarityWeightBonus
 * @property {'rarityWeight'} type
 * @property {string} rarity
 * @property {number} multiplier
 *
 * @typedef {Object} BaseFishRateBonus
 * @property {'baseFishRate'} type
 * @property {number} amount
 *
 * @typedef {ForceDepthBonus | GlobalFishWeightBonus | FishWeightBonus |
 *            EventVoteBonus | RarityWeightBonus | BaseFishRateBonus} Bonus
 */

/**
 * Given an array of card names, return a flat list of bonuses
 * @param {string[]} cardNames
 * @returns {Bonus[]}
 */
export function getBonusesFromCards(cardNames = []) {
  if (!Array.isArray(cardNames)) {
    console.warn('getBonusesFromCards expected an array, got', cardNames);
    cardNames = [];
  }

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

    if (Array.isArray(card['attract-rarity']) && card['attract-weight'] > 1) {
      for (const rar of card['attract-rarity']) {
        bonuses.push({ type: 'rarityWeight', rarity: rar, multiplier: card['attract-weight'] });
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
 * Applies any rarity-based bonuses to a pickList.
 * @param {[string, any][]} pickList
 * @param {Bonus[]} bonuses
 * @returns {[string, any][]}
 */
export function applyRarityWeightBonuses(pickList, bonuses) {
  const rarityMults = bonuses
    .filter(b => b.type === 'rarityWeight')
    .reduce((m, b) => {
      m[b.rarity] = (m[b.rarity] || 1) * b.multiplier;
      return m;
    }, {});

  return pickList.map(([type, stats]) => {
    const base = Number(stats['base-catch-rate'] || 0);
    const rmul = rarityMults[stats.rarity] || 1;
    return [type, { ...stats, 'base-catch-rate': base * rmul }];
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
 * Applies a flat bonus to all non-junk fish
 * @param {[string, any][]} pickList
 * @param {Bonus[]} bonuses
 * @returns {[string, any][]}
 */
export function applyBaseFishRateBonus(pickList, bonuses) {
  const baseBonus = bonuses.find(b => b.type === 'baseFishRate');
  if (!baseBonus) return pickList;
  const amt = baseBonus.amount;

  return pickList.map(([type, stats]) => {
    if (stats.rarity !== 'junk') {
      const base = Number(stats['base-catch-rate'] || 0);
      return [type, { ...stats, 'base-catch-rate': base + amt }];
    }
    return [type, stats];
  });
}

/**
 * Given the raw cast array of numbers, pull matching cards by index
 * and return combined bonuses (including base-fish-rate).
 * @param {number[]} cast
 * @returns {Bonus[]}
 */
export function getBonusesFromCast(cast = []) {
  if (!Array.isArray(cast)) {
    console.warn('getBonusesFromCast expected array, got', cast);
    cast = [];
  }

  // 1) extract card names by index
  const idxMap = new Map();
  for (const [name, card] of Object.entries(cardsDb.data.cards)) {
    if (typeof card.index === 'number') {
      idxMap.set(card.index, name);
    }
  }

  const cardNames = [];
  for (const n of cast) {
    const nm = idxMap.get(n);
    if (nm && !cardNames.includes(nm)) {
      cardNames.push(nm);
    }
  }

  // 2) gather all standard bonuses
  const bonuses = getBonusesFromCards(cardNames);

  // 3) pick up any base-fish-catch-rate from the cards themselves
  for (const n of cast) {
    const card = cardsDb.data.cards[ [...idxMap.keys()].find(k => k === n) ];
    if (card && typeof card['base-fish-catch-rate'] === 'number') {
      bonuses.push({
        type: 'baseFishRate',
        amount: card['base-fish-catch-rate']
      });
    }
  }

  return bonuses;
}
