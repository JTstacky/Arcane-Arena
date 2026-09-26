// Headless simulation tests: run whole games with bots only and check that
// they progress through every phase and finish without throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WarlockGame } from '../server/warlock.js';

function fakeRoom(n) {
  const players = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Bot${i + 1}`, slot: i, bot: true }));
  return {
    playerList: () => players,
    isBot: () => true,
    isConnected: () => true,
    nameOf: (id) => `Bot${id}`,
    colorOf: () => '#fff',
  };
}

function run(game, maxSeconds) {
  const dt = 1 / 30;
  const phases = new Set();
  for (let t = 0; t < maxSeconds && !game.over; t += dt) {
    game.tick(dt);
    phases.add(game.phase);
    if (Math.round(t / dt) % 2 === 0) {
      const s = game.snapshot(1);
      JSON.stringify(s);
      game.events = [];
    }
  }
  return phases;
}

test('warlock: bots play a full 3-round game', () => {
  const g = new WarlockGame(fakeRoom(6), { rounds: 3 });
  const phases = run(g, 60 * 40);
  assert.ok(g.over, 'game should finish');
  assert.deepEqual([...phases].sort(), ['over', 'play', 'roundEnd', 'shop']);
  const st = g.standings();
  assert.equal(st.length, 6);
  const totalDmg = st.reduce((a, s) => a + s.dmg, 0);
  console.log('  warlock standings', st);
  assert.ok(totalDmg > 0, 'bots should hurt each other');
});
