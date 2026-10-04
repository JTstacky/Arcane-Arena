// Checks the simulation against what was measured in the real Warcraft III
// engine (docs/wc3-observations.md): turning and the propulsion window,
// walking speed and arrival, cast timing, knockback and lava.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Unit, stepUnits, WC3 } from '../engine/server/sim.js';
import { WarlockGame } from '../server/warlock.js';
import { WARLOCK, UNIT } from '../shared/warlockData.js';

const STEP = WC3.STEP;
const deg = (d) => (d * Math.PI) / 180;

function standingTurn(theta) {
  const u = new Unit({ kind: 'warlock', speed: WARLOCK.speed });
  u.setFacing(0);
  u.order(Math.cos(deg(theta)) * 20, Math.sin(deg(theta)) * 20);
  for (let step = 1; step <= 10; step++) {
    stepUnits([u], STEP, { friction: 0.96, controlLoss: false });
    if (u.x || u.y) return { step, dir: (Math.atan2(u.y, u.x) * 180) / Math.PI };
  }
  return null;
}

test('standing turns start walking on the measured step, in the measured direction', () => {
  // [turn, step walking starts, first walking direction] from the engine log.
  const measured = [[0, 1, 0], [15, 1, 14.8], [30, 1, 30], [45, 1, 34.1], [75, 2, 68.2], [90, 2, 68.7],
    [105, 3, 102.9], [120, 3, 103.8], [135, 4, 135], [150, 4, 137.3], [165, 5, 165.1], [180, 5, 171.8], [-90, 2, -68.8]];
  for (const [theta, step, dir] of measured) {
    const r = standingTurn(theta);
    assert.equal(r.step, step, `${theta}°: walks from step ${r.step}, expected ${step}`);
    const got = theta === 180 ? Math.abs(r.dir) : r.dir; // an exact about-face may turn either way
    assert.ok(Math.abs(got - dir) < 3, `${theta}°: first direction ${r.dir.toFixed(1)}°, expected ${dir}°`);
  }
});

test('walks at 210 u/s from the first step and stops about 11 u short', () => {
  const u = new Unit({ kind: 'warlock', speed: WARLOCK.speed });
  u.order(800 * UNIT, 0);
  stepUnits([u], STEP, { friction: 0.96, controlLoss: false });
  assert.ok(Math.abs(u.x / UNIT - 6.3) < 1e-6, 'full speed in the first step');
  for (let i = 0; i < 200 && u.target; i++) stepUnits([u], STEP, { friction: 0.96, controlLoss: false });
  assert.equal(u.target, null);
  assert.ok(Math.abs((800 * UNIT - u.x) / UNIT - 11) < 0.5, `stops ${((800 * UNIT - u.x) / UNIT).toFixed(1)} u short`);
});

test('the model lags the heading: after a 180° order it faces the new way about 0.5 s later', () => {
  const u = new Unit({ kind: 'warlock', speed: WARLOCK.speed });
  u.setFacing(0);
  u.order(-20, 0.001);
  let t = 0;
  while (Math.abs(Math.abs(u.facing) - Math.PI) > 0.05 && t < 2) {
    stepUnits([u], STEP, { friction: 0.96, controlLoss: false });
    t += STEP;
  }
  assert.ok(t > 0.4 && t < 0.7, `display facing settled after ${t.toFixed(2)} s`);
  assert.ok(u.x < 0, 'already walking toward the target while the model still turns');
});

function fakeRoom(n) {
  const players = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, slot: i, bot: false }));
  return { playerList: () => players, isBot: () => false, isConnected: () => true, nameOf: (id) => `P${id}`, colorOf: () => '#fff', tuning: {} };
}

function duel() {
  const g = new WarlockGame(fakeRoom(2), { rounds: 3 });
  g.startRound();
  g.obstacles = []; // random pillars would stop the test projectiles
  const a = g.ps.get(1);
  const b = g.ps.get(2);
  a.unit.x = 0; a.unit.y = 0; a.unit.setFacing(0);
  b.unit.x = 10; b.unit.y = 0;
  return { g, a, b };
}

test('casting: instant when facing, otherwise on the step after the heading is on target; 0.3 s cast point', () => {
  const { g, a } = duel();
  g.command(1, { c: 'cast', spell: 'fireball', x: 5, y: 0 });
  assert.equal(g.projectiles.length, 1, 'launched in the same tick when already facing');
  assert.ok(a.unit.casting?.lock > 0, 'locked for the cast point');
  // A right-click during the cast point waits for it.
  g.command(1, { c: 'move', x: 0, y: 5 });
  assert.equal(a.unit.target, null);
  for (let i = 0; i < 10; i++) g.tick(STEP);
  assert.ok(a.unit.target, 'the queued move runs once the cast point ends');
  assert.ok(Math.abs(a.cds.fireball - 4.8) < 0.05, `cooldown starts after the cast point (${a.cds.fireball})`);

  // 90°: three turn steps, then the cast begins on the next step (0.09-0.12 s).
  const d = duel();
  d.g.command(1, { c: 'cast', spell: 'fireball', x: 0, y: 5 });
  let steps = 0;
  while (!d.g.projectiles.length && steps < 20) {
    d.g.tick(STEP);
    steps++;
  }
  assert.equal(steps, 4);
});

test('knockback: Δv = D·(100+M) u/s with M including the hit, ×0.96 per step; slide 539 u', () => {
  const { g, b } = duel();
  b.unit.x = 0; b.unit.y = 0;
  g.damage(b, 7, g.ps.get(1), 1, 0);
  assert.equal(b.unit.kbPoints, 7);
  assert.ok(Math.abs(b.unit.vx / UNIT - 7 * 107) < 1e-6);
  const x0 = b.unit.x;
  for (let i = 0; i < 1000; i++) stepUnits([b.unit], STEP, { friction: WARLOCK.friction, controlLoss: false });
  const slide = (b.unit.x - x0) / UNIT;
  assert.ok(Math.abs(slide - 539) < 1, `slide ${slide.toFixed(1)} u`);
});

test('lava burns 0.9 HP every 0.1 s and adds half of it to damage taken', () => {
  const { g, a } = duel();
  a.unit.x = g.arenaR + 2;
  for (let i = 0; i < 100; i++) {
    g.tick(STEP);
    a.unit.x = g.arenaR + 2;
    a.unit.vx = a.unit.vy = 0;
  }
  // 3 s: 30 ticks of 0.9 damage, with 0.5 HP/s regen in between.
  assert.ok(Math.abs(100 - a.unit.hp - (27 - 1.5)) < 1.2, `hp ${a.unit.hp.toFixed(2)}`);
  assert.ok(Math.abs(a.unit.kbPoints - 13.5) < 0.5, `damage taken ${a.unit.kbPoints}`);
});

test('lobby options: no rocks by default; everyone starts with Fireball and Scourge', () => {
  const g = new WarlockGame(fakeRoom(2), { rounds: 3 });
  g.startRound();
  assert.equal(g.obstacles.length, 0);
  assert.deepEqual(g.ps.get(1).spells, { fireball: 1, scourge: 1 });
  const r = new WarlockGame(fakeRoom(2), { rounds: 3, rocks: 1 });
  r.startRound();
  assert.ok(r.obstacles.length > 0, 'rocks on when the host picks them');
});

test('shield is autocast: it goes up by itself before a fireball hits, and cannot be cast by hand', () => {
  const { g, a, b } = duel();
  b.spells.shield = 1;
  g.cast(b, 'shield', b.unit.x, b.unit.y);
  assert.ok(!(b.unit.buffs.shield > 0), 'no manual cast');
  g.command(1, { c: 'cast', spell: 'fireball', x: 10, y: 0 });
  const hp = b.unit.hp;
  for (let i = 0; i < 60; i++) g.tick(STEP);
  assert.ok(b.cds.shield > 0, 'shield went up and is cooling down');
  assert.equal(b.unit.hp, hp, 'the fireball was reflected');
  assert.ok(a.unit.hp < a.unit.maxHp, 'back at the caster');
});

test('scourge winds up for 1 s, cannot be cancelled, and orders wait for it', () => {
  const { g, a, b } = duel();
  b.unit.x = 2; // inside the blast
  const hp = b.unit.hp;
  g.command(1, { c: 'cast', spell: 'scourge', x: 0, y: 0 });
  let steps = 0;
  while (b.unit.hp === hp && steps < 60) {
    g.tick(STEP);
    steps++;
  }
  assert.ok(Math.abs(steps * STEP - 1) < 0.05, `blast after ${(steps * STEP).toFixed(2)} s`);

  const d = duel();
  d.b.unit.x = 2;
  const hp2 = d.b.unit.hp;
  d.g.command(1, { c: 'cast', spell: 'scourge', x: 0, y: 0 });
  for (let i = 0; i < 10; i++) d.g.tick(STEP);
  const x0 = d.a.unit.x;
  d.g.command(1, { c: 'move', x: -5, y: 0 });
  for (let i = 0; i < 20; i++) d.g.tick(STEP);
  assert.equal(d.a.unit.x, x0, 'no walking during the wind-up');
  for (let i = 0; i < 20; i++) d.g.tick(STEP);
  assert.ok(d.b.unit.hp < hp2, 'the blast still went off');
  for (let i = 0; i < 30; i++) d.g.tick(STEP);
  assert.ok(d.a.unit.x < x0, 'the queued move ran afterwards');
});

test('once only bots are left alive, the round plays at 5x speed', () => {
  const room = fakeRoom(3);
  room.isBot = (id) => id !== 1;
  const g = new WarlockGame(room, { rounds: 3 });
  g.startRound();
  g.tick(STEP);
  assert.ok(Math.abs(g.roundTime - STEP) < 1e-9, 'normal speed while a human fights');
  g.ps.get(1).unit.alive = false;
  const t = g.roundTime;
  g.tick(STEP);
  assert.ok(Math.abs(g.roundTime - t - 5 * STEP) < 1e-9, 'five steps per tick');
  g.startRound();
  assert.equal(g.fastForward, false, 'a new round is back to normal');
});

test('self-explode upgrades hit harder but always cost the caster 10', () => {
  const blast = (lvl) => {
    const { g, a, b } = duel();
    a.spells.scourge = lvl;
    b.unit.x = 2;
    const hpA = a.unit.hp;
    const hpB = b.unit.hp;
    g.command(1, { c: 'cast', spell: 'scourge', x: 0, y: 0 });
    for (let i = 0; i < 40; i++) g.tick(STEP);
    return { self: hpA - a.unit.hp, dealt: hpB - b.unit.hp, push: b.unit.x - 2 };
  };
  const l1 = blast(1);
  const l3 = blast(3);
  // (less a little health regenerated over the wind-up)
  assert.ok(Math.abs(l1.self - 10) < 0.3, `level 1 cost ${l1.self}`);
  assert.ok(Math.abs(l3.self - 10) < 0.3, `level 3 cost ${l3.self}`);
  assert.ok(l3.dealt > l1.dealt, 'more damage');
  assert.ok(l3.push > l1.push * 1.3, 'more knockback');
});

test('interest: a quarter of the gold kept through a round, on top of the pay', () => {
  const { g, a, b } = duel();
  a.gold = 23;
  b.gold = 0;
  b.unit.alive = false;
  g.tick(STEP); // a is the last one standing: the round ends
  assert.equal(a.gold, 23 + 5 + WARLOCK.goldPerRound);
  assert.equal(b.gold, WARLOCK.goldPerRound);
});

test('plasma ball: 0.25 s charge, a slow ball, a wide blast that spares the caster', () => {
  const { g, a, b } = duel();
  a.spells.plasma = 1;
  b.unit.x = 6;
  const hpA = a.unit.hp;
  const hpB = b.unit.hp;
  g.command(1, { c: 'cast', spell: 'plasma', x: 6, y: 0 });
  for (let i = 0; i < 7; i++) g.tick(STEP);
  assert.equal(g.projectiles.filter((p) => p.kind === 'plasma').length, 0, 'still charging at 0.21 s');
  for (let i = 0; i < 3; i++) g.tick(STEP);
  assert.equal(g.projectiles.filter((p) => p.kind === 'plasma').length, 1, 'launched after the charge');
  let t = 0;
  while (b.unit.hp === hpB && t < 3) {
    g.tick(STEP);
    t += STEP;
  }
  assert.ok(t > 0.35, `slow: reached 6 m away after ${t.toFixed(2)} s`);
  assert.ok(hpB - b.unit.hp >= 10, `big hit: ${hpB - b.unit.hp}`);
  assert.ok(a.unit.hp >= hpA - 0.01, 'the caster is not hurt');
});
