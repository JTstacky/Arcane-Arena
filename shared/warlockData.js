// Spell and item definitions for Warlock, shared by server and client.
//
// Values follow Warlock Brawl — the official port of the original WC3 map by
// its author (github.com/warlockbrawl/warlock) — converted from WC3/Dota
// distance units at 50 units = 1 metre. Damage uses the original 1000-HP scale.
//
// Cast points: 0.2 s unless a spell sets castPoint (Brawl's AbilityCastPoint).
//
// Spells are bought in columns: you may own one spell per column (like the
// original shop), plus the Fireball and Scourge "items".

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
  hp: 1000,
  regen: 5,
  speed: 210 * UNIT, // 4.2 m/s
  radius: 0.6,
  friction: -Math.log(0.96) / 0.035, // velocity *= 0.96 every 35ms tick
  kbDmgToVelocity: 10 * UNIT,
  lavaDps: 100,
  lavaKbFactor: 0.5, // lava only adds half its damage to knockback points
  layer: 75 * UNIT, // arena radius per "layer"
  baseLayers: 13,
  layersPerPlayer: 1,
  shrinkPeriod: 10,
  spawnInset: 600 * UNIT,
  invulnTime: 2,
  startGold: 30,
  goldPerRound: 10,
  shopTime: 30,
};

export const SPELLS = {
  fireball: {
    name: 'Fireball', icon: '🔥', color: '#ff7a1a', slot: 0,
    cost: 0, upCost: [7, 7, 7, 7, 7, 7], maxLevel: 7,
    desc: 'A fast bolt of fire that knocks back the first warlock it hits. Collides with other projectiles. Lightning detonates it.',
    cd: 4.8, dmg: lin(70, 112), speed: 1000 * UNIT, range: 1000 * UNIT, radius: 0.5,
  },
  scourge: {
    name: 'Scourge', icon: '💥', color: '#c050ff', slot: 7,
    cost: 7, upCost: [7, 7], maxLevel: 3,
    desc: 'Blast everything around you — but it costs you the same amount of health.',
    cd: 3, dmg: [100, 120, 140], aoe: 250 * UNIT,
  },
  // ---- Column 1: projectiles
  boomerang: {
    name: 'Boomerang', icon: '🪃', color: '#ffd84d', slot: 1,
    cost: 11, upCost: [7, 8, 9, 10, 11, 12], maxLevel: 7,
    desc: 'Flies out in an arc and returns to you, able to hit on both legs.',
    cd: [16, 13.9, 12.5, 11.7, 11, 10.3, 9.6], dmg: lin(70, 106), range: 800 * UNIT, speed: 1000 * UNIT, radius: 0.76,
  },
  lightning: {
    name: 'Lightning', icon: '⚡', color: '#9fd4ff', slot: 1,
    cost: 11, upCost: [8, 9, 10, 11, 12, 13], maxLevel: 7,
    desc: 'Instantly strikes the first thing in a line. Hitting a Fireball detonates it in a big explosion.',
    cd: [16.5, 15.5, 15, 14.5, 14, 13.5, 13], dmg: lin(70, 118), range: 600 * UNIT, kbf: 0.92,
  },
  homing: {
    name: 'Homing', icon: '🎯', color: '#4db8ff', slot: 1,
    cost: 11, upCost: [8, 9, 10, 11, 12, 13], maxLevel: 7,
    desc: 'An orb that seeks the nearest enemy warlock and explodes on impact.',
    cd: [16.5, 14.5, 13, 12, 11, 10, 9], dmg: lin(70, 130), speed: 1000 * UNIT, life: 4.5, radius: 0.6, turn: 3.2, aoe: 3,
  },
  // ---- Column 2: mobility
  teleport: {
    castPoint: 0,
    name: 'Teleport', icon: '✨', color: '#d9f3ff', slot: 2,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Blink to the target point.',
    cd: [16, 13.5, 11.5, 10, 9, 8, 7], range: lin(770 * UNIT, 1190 * UNIT),
  },
  thrust: {
    castPoint: 0,
    name: 'Thrust', icon: '💨', color: '#ffe8a8', slot: 2,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Dash toward the target, slamming into the first warlock in your path.',
    cd: [16.5, 14.5, 13, 12, 11, 10, 9], dmg: lin(50, 80), range: 900 * UNIT, dashSpeed: 32, radius: 60 * UNIT,
  },
  swap: {
    castPoint: 0,
    name: 'Swap', icon: '🔄', color: '#ff9cf4', slot: 2,
    cost: 11, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'A very fast projectile. Swap places with whoever it hits — or with the projectile itself if it hits nothing.',
    cd: [15.8, 13.3, 11.3, 9.8, 8.8, 7.8, 7], speed: 1983 * UNIT, range: 1983 * 0.4706 * UNIT, radius: 0.8,
  },
  // ---- Column 3: orbs
  drain: {
    name: 'Drain', icon: '🩸', color: '#d0102a', slot: 3,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Steals life from the warlock hit and slows them.',
    cd: [22, 21, 20, 19, 18, 17, 16], dmg: lin(60, 120), duration: lin(4, 10), speed: 700 * UNIT, range: 850 * UNIT, radius: 0.5, slow: 0.3,
  },
  bouncer: {
    name: 'Bouncer', icon: '🟢', color: '#6dff5a', slot: 3,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'After hitting a warlock the orb bounces on to the next nearest one.',
    cd: [19, 18, 17, 16, 15, 14, 13], dmg: lin(54, 102), speed: 900 * UNIT, range: 900 * UNIT, radius: 0.76, bounces: [2, 2, 3, 3, 3, 4, 4],
  },
  // ---- Column 4: power
  meteor: {
    name: 'Meteor', icon: '☄️', color: '#ff4a1a', slot: 4,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Calls a meteor down on the target point. Huge knockback at the centre of the impact.',
    cd: lin(20, 17), dmgMin: 40, dmg: lin(110, 170), aoe: [225, 240, 255, 269, 282, 294, 304].map((v) => v * UNIT), range: 1000 * UNIT, delay: 1.15,
  },
  windwalk: {
    castPoint: 0,
    name: 'Windwalk', icon: '👻', color: '#c8e7ff', slot: 4,
    cost: 14, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Turn invisible and much faster. Running into a warlock deals damage and ends it.',
    cd: [29, 26, 23.5, 21, 19.5, 18.5, 17.5], dmg: lin(54, 90), duration: 2.6, speedBonus: 200 * UNIT,
  },
  // ---- Column 5: defence
  shield: {
    castPoint: 0,
    name: 'Shield', icon: '🛡️', color: '#ffe066', slot: 5,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Reflects projectiles that enter the shield around you.',
    cd: lin(14, 8), duration: 1.2, aoe: lin(200 * UNIT, 260 * UNIT),
  },
  rush: {
    castPoint: 0,
    name: 'Rush', icon: '🔰', color: '#7fe0ff', slot: 5,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'A barrier that absorbs incoming damage — and the knockback that comes with it.',
    cd: lin(21, 15), absorb: lin(50, 170), duration: lin(6, 9),
  },
  // ---- Column 6: control
  gravity: {
    name: 'Gravity', icon: '🌀', color: '#b36bff', slot: 6,
    cost: 12, upCost: [7, 8, 9, 10, 11, 12], maxLevel: 7,
    desc: 'A slow singularity that drags warlocks toward it and damages those close by.',
    cd: lin(21, 18), dmg: lin(20, 100), speed: 450 * UNIT, range: 900 * UNIT, pull: lin(500 * UNIT, 680 * UNIT), pullRadius: 550 * UNIT, dmgRadius: 250 * UNIT, radius: 0.5,
  },
  link: {
    name: 'Link', icon: '⛓️', color: '#8affd8', slot: 6,
    cost: 12, upCost: [6, 7, 8, 9, 10, 11], maxLevel: 7,
    desc: 'Chains you to the warlock hit, dragging them toward you.',
    cd: [17, 15, 13, 11, 9, 7, 7], dmg: lin(12, 60), speed: 950 * UNIT, range: 860 * UNIT, radius: 0.7, pull: 1550 * UNIT, duration: 3,
  },
};

// Items: buy again to level up (the cost is paid for every level).
export const ITEMS = {
  ring: { name: 'Ring of Health', icon: '💍', cost: 4, maxLevel: 5, hp: [100, 190, 270, 340, 400], desc: '+100 / 190 / 270 / 340 / 400 maximum health.' },
  cursed: { name: 'Cursed Ring', icon: '🧿', cost: 4, maxLevel: 2, hp: [100, 200], kb: [0.15, 0.15], debuff: [0.25, 0.3], desc: '+100 / 200 health and -15% knockback, but debuffs last 25 / 30% longer.' },
  cape: { name: 'Cape', icon: '🧣', cost: 3, maxLevel: 3, regen: [1.5, 2.5, 3.5], desc: '+1.5 / 2.5 / 3.5 health regeneration.' },
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
