// Spell and item definitions for Warlock, shared by server and client.
//
// Numbers follow the original map on its own 100-HP scale: Warlock v1.02
// (docs/research.md) for the spells, rules and economy, and the measured
// Warlock 0.99 engine behaviour (docs/wc3-observations.md) for movement,
// casting and knockback. Values missing from both come from Warlock Brawl, the
// author's own port (github.com/warlockbrawl/warlock).
//
// Distances are WC3 units converted to metres at 50 units = 1 metre.
// Spells are bought in columns: you may own one spell per column (like the
// original shop), plus the Fireball and Scourge.

export const UNIT = 1 / 50; // metres per WC3 unit

// Per-level tables. lin(a, b) interpolates 7 levels from a to b.
const lin = (a, b, n = 7) => Array.from({ length: n }, (_, i) => +(a + ((b - a) * i) / (n - 1)).toFixed(2));

export const SLOT_KEYS = ['Q', 'W', 'E', 'R', 'D', 'F', 'G', 'T'];
// Slot 0 = Fireball, slots 1-6 = shop columns, slot 7 = Scourge.
export const COLUMNS = [
  { slot: 1, name: 'Projectile' },
  { slot: 2, name: 'Mobility' },
  { slot: 3, name: 'Orb' },
  { slot: 4, name: 'Power' },
  { slot: 5, name: 'Defence' },
  { slot: 6, name: 'Control' },
];
export const MAX_ITEMS = 6;

export const WARLOCK = {
  // Unit h000 (object data): 100 HP, 0.5 HP/s regen, speed 210, collision 25.
  hp: 100,
  regen: 0.5,
  speed: 210 * UNIT, // 4.2 m/s
  radius: 25 * UNIT,
  castPoint: 0.3, // the unit's cast point: locked for 0.3 s after a spell starts
  // Knockback: a hit adds 0.03·D·(100+M) units per 0.03 s step, where M is the
  // damage taken this round including the hit, so D·(100+M) units per second.
  // Every step the velocity is multiplied by 0.96; the whole slide is
  // 0.72·D·(100+M) units (539 u for a Fireball on a fresh warlock).
  friction: 0.96,
  kbBase: 100,
  // Lava: checked every 0.1 s under the warlock, 9 HP/s. Lava adds half its
  // damage to the damage taken (v1.02).
  lavaTick: 0.1,
  lavaDps: 9,
  lavaKbFactor: 0.5,
  // Arena: a disc of 9 + floor(sqrt(players)) tiles that loses a tile every
  // 15·sqrt(alive) seconds.
  tile: 128 * UNIT,
  baseTiles: 9,
  shrinkPeriod: 15,
  // Start positions: a circle of radius 768 + 64·players units, facing the centre.
  spawnBase: 768 * UNIT,
  spawnPerPlayer: 64 * UNIT,
  startGold: 20,
  goldPerRound: 10,
  interest: 0.25, // at each round's end, a bonus of this share of the gold you kept (our addition)
  shopTime: 30,
  firstShopTime: 40,
};

export const SPELLS = {
  fireball: {
    name: 'Fireball', icon: '🔥', color: '#ff7a1a', slot: 0,
    cost: 0, upCost: [7, 7, 7, 7, 7, 7], maxLevel: 7,
    desc: 'A fast bolt of fire that knocks back the first warlock it hits. Destroys enemy projectiles it meets. Lightning detonates it.',
    // 30 units per 0.03 s step for 33 steps; hits anything within 75 units of its centre.
    // Each level also adds 60 units of range and takes 0.2 s off the cooldown
    // (not in the original map, where only the damage grows).
    cd: lin(4.8, 3.6), dmg: lin(7, 10), speed: 1000 * UNIT, range: lin(990, 1350).map((v) => v * UNIT), radius: 50 * UNIT,
  },
  // Scourge in the original map; the id stays 'scourge' (art, saved games).
  scourge: {
    name: 'Self-Explode', icon: '💥', color: '#c050ff', slot: 7,
    cost: 7, upCost: [7, 7], maxLevel: 3,
    desc: 'After a 1 second wind-up you can’t stop, blow up: everyone around you is hurt and thrown back. It costs you 10 health every time (it can’t kill you). Upgrades add damage and knockback and shorten the cooldown, but the cost stays 10.',
    // Our change: upgrades add knockback and cut the cooldown, and the cost to
    // you stays 10 (in the map you lost as much as you dealt: 10/12/14).
    cd: [3, 2.5, 2], dmg: [10, 13, 16], kbPct: [100, 125, 150], selfDmg: 10, aoe: 250 * UNIT,
    castTime: 1, // seconds of wind-up before the blast; it can't be cancelled
  },
  // ---- Column 1: projectiles
  boomerang: {
    name: 'Boomerang', icon: '🪃', color: '#ffd84d', slot: 1,
    cost: 11, upCost: [7, 8, 9, 10, 11, 12], maxLevel: 7,
    desc: 'Flies out in an arc and returns to you, able to hit on both legs.',
    cd: lin(16, 10.3), dmg: lin(7, 10), range: 800 * UNIT, speed: 1000 * UNIT, radius: 0.76,
  },
  lightning: {
    name: 'Lightning', icon: '⚡', color: '#9fd4ff', slot: 1,
    cost: 11, upCost: [8, 9, 10, 11, 12, 13], maxLevel: 7,
    desc: 'Instantly strikes the first thing in a line. Hitting a Fireball detonates it in a big explosion.',
    cd: lin(16.5, 13.5), dmg: lin(7, 11), range: 600 * UNIT, kbf: 0.92,
  },
  homing: {
    name: 'Homing', icon: '🎯', color: '#4db8ff', slot: 1,
    cost: 11, upCost: [8, 9, 10, 11, 12, 13], maxLevel: 7,
    desc: 'An orb that seeks the nearest enemy warlock and explodes on impact.',
    cd: lin(15, 11), dmg: lin(7, 12), speed: 1000 * UNIT, life: 4.5, radius: 0.6, turn: 3.2, aoe: 3,
  },
  // ---- Column 2: mobility
  teleport: {
    name: 'Teleport', icon: '✨', color: '#d9f3ff', slot: 2,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Blink to the target point. Takes 20% off your current knockback.',
    // Our balance (playtest): quicker and further than the map's 16 → 7 s, 770 → 1190.
    cd: lin(12, 5), range: lin(900 * UNIT, 1400 * UNIT), kbCut: 0.8,
  },
  thrust: {
    name: 'Thrust', icon: '💨', color: '#ffe8a8', slot: 2,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Dash toward the target, slamming into the first warlock in your path.',
    cd: lin(16.5, 9), dmg: lin(5.4, 7.8), range: 900 * UNIT, dashSpeed: 1100 * UNIT, radius: 60 * UNIT,
  },
  swap: {
    name: 'Swap', icon: '🔄', color: '#ff9cf4', slot: 2,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'A very fast projectile. Swap places with whoever it hits — or with the projectile itself if it hits nothing.',
    cd: lin(15.8, 8.8), speed: 1983 * UNIT, range: 1983 * 0.4706 * UNIT, radius: 0.8,
  },
  // ---- Column 3: orbs
  drain: {
    name: 'Drain', icon: '🩸', color: '#d0102a', slot: 3,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Steals life from the warlock hit and slows them by 50 movement speed.',
    cd: lin(22, 16), dmg: lin(6, 12), duration: lin(4, 10), speed: 700 * UNIT, range: 850 * UNIT, radius: 0.5, slow: 50 * UNIT,
  },
  bouncer: {
    name: 'Bouncer', icon: '🟢', color: '#6dff5a', slot: 3,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'After hitting a warlock the orb bounces on to the next nearest one, losing 20% damage per bounce.',
    cd: lin(20, 15), dmg: lin(5.4, 10.2), speed: 900 * UNIT, range: 900 * UNIT, radius: 0.76, bounces: [2, 2, 3, 3, 3, 4, 4], bounceLoss: 0.8,
  },
  // ---- Column 4: power
  meteor: {
    name: 'Meteor', icon: '☄️', color: '#ff4a1a', slot: 4,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Calls a meteor down on the target point. Huge knockback at the centre of the impact.',
    // Hits harder than the original map's 4–11 / 11–17 (playtest feedback).
    cd: lin(20, 17), dmgMin: lin(6, 13), dmg: lin(16, 25), aoe: [225, 237, 248, 260, 271, 283, 294].map((v) => v * UNIT), range: 1000 * UNIT, delay: 1.15,
  },
  windwalk: {
    name: 'Windwalk', icon: '👻', color: '#c8e7ff', slot: 4,
    cost: 15, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Turn invisible and much faster. Running into a warlock deals damage and ends it. Upgrades make it faster and longer too.',
    // Our change (playtest): upgrades also add speed (200 -> 320) and time
    // (2.6 -> 4 s); in the map only the damage and cooldown improve.
    cd: lin(30, 19.5), dmg: lin(5.4, 9), duration: lin(2.6, 4), speedBonus: lin(200 * UNIT, 320 * UNIT),
  },
  // ---- Column 5: defence
  shield: {
    name: 'Shield', icon: '🛡️', color: '#ffe066', slot: 5,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Autocast: goes up by itself when a projectile is about to hit you, reflecting projectiles that enter it.',
    // Our balance (playtest): the map's 25 → 17 s cooldown and 2.8 → 3.8 s made
    // an autocast shield too strong.
    cd: lin(32, 24), duration: lin(1.4, 1.9), aoe: lin(200 * UNIT, 260 * UNIT),
  },
  rush: {
    name: 'Rush', icon: '🔰', color: '#7fe0ff', slot: 5,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'A barrier that absorbs incoming damage — and the knockback that comes with it.',
    // Our balance (playtest): stronger and more often than the map's 21 → 15 s, 5 → 17.
    cd: lin(16, 10), absorb: lin(9, 24), duration: lin(6, 9),
  },
  // ---- Column 6: control
  gravity: {
    name: 'Gravity', icon: '🌀', color: '#b36bff', slot: 6,
    cost: 12, upCost: [7, 8, 9, 10, 11, 12], maxLevel: 7,
    desc: 'A slow singularity that drags warlocks toward it and damages those close by. Upgrades pull much harder.',
    // Our change (playtest): a stronger pull (500 -> 900, was -> 680) and a
    // shorter cooldown (21 -> 13 s, was -> 19) with upgrades.
    cd: lin(21, 13), dmg: lin(2, 10), speed: 450 * UNIT, range: 900 * UNIT, pull: lin(500 * UNIT, 900 * UNIT), pullRadius: 550 * UNIT, dmgRadius: 250 * UNIT, radius: 0.5,
  },
  link: {
    name: 'Link', icon: '⛓️', color: '#8affd8', slot: 6,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Chains you to the warlock hit, dragging them toward you.',
    cd: lin(17, 7), dmg: lin(1.2, 6), speed: 950 * UNIT, range: 860 * UNIT, radius: 0.7, pull: 1550 * UNIT, duration: 3,
  },
};

// Items: buy again to level up (the cost is paid for every level).
export const ITEMS = {
  ring: { name: 'Ring of Health', icon: '💍', cost: 4, maxLevel: 5, hp: [10, 19, 27, 34, 40], desc: '+10 / 19 / 27 / 34 / 40 maximum health.' },
  // Our change (playtest): a real trade (the map's gave health as well).
  cursed: { name: 'Cursed Ring', icon: '🧿', cost: 4, maxLevel: 2, hp: [-10, -15], kb: [0.18, 0.28], desc: '-18 / 28% knockback taken, but -10 / 15 maximum health.' },
  cape: { name: 'Cape', icon: '🧣', cost: 3, maxLevel: 3, regen: [0.15, 0.25, 0.35], desc: '+0.15 / 0.25 / 0.35 health regeneration.' },
  armor: { name: 'Armor', icon: '🦺', cost: 6, maxLevel: 3, kb: [0.12, 0.18, 0.22], desc: '-12 / 18 / 22% knockback taken.' },
  boots: { name: 'Boots', icon: '👢', cost: 5, maxLevel: 3, speed: [18, 29, 40].map((v) => v * UNIT), desc: '+18 / 29 / 40 movement speed.' },
  watch: { name: 'Pocket Watch', icon: '⌚', cost: 2, maxLevel: 2, debuff: [-0.35, -0.45], desc: 'Debuffs on you (slow, link) last 35 / 45% shorter.' },
};

export function stat(def, key, level = 1) {
  const v = def[key];
  if (Array.isArray(v)) return v[Math.min(level, v.length) - 1];
  return v;
}

export function itemStat(items, key) {
  let total = 0;
  for (const [id, lvl] of Object.entries(items)) {
    const arr = ITEMS[id]?.[key];
    if (arr) total += arr[lvl - 1];
  }
  return total;
}

export function upgradeCost(def, level) {
  // Cost to go from `level` to `level + 1`.
  if (level === 0) return def.cost;
  return def.upCost[level - 1] ?? def.upCost[def.upCost.length - 1];
}
