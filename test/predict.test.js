// Client-side prediction: the client's forecast of its own hero must match
// where the host really puts it, at several network latencies.
import test from 'node:test';
import assert from 'node:assert/strict';

let clock = 0; // seconds; the predictor reads performance.now()
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock * 1000 }, configurable: true });

const { WarlockGame } = await import('../server/warlock.js');
const { Predictor } = await import('../engine/client/predict.js');
const { SPELLS, WARLOCK } = await import('../shared/warlockData.js');

const STEP = 0.03;
const SELF = new Set(['rush', 'windwalk', 'scourge']);
const ORDERS = [[0.3, { c: 'move', x: 6, y: 0 }], [0.9, { c: 'move', x: 0, y: 6 }], [1.4, { c: 'cast', spell: 'fireball', x: -5, y: -5 }], [1.5, { c: 'move', x: 5, y: 5 }], [2.4, { c: 'stop' }], [2.6, { c: 'move', x: -4, y: 2 }]];

function run(lat) {
  clock = 0;
  const ps = [1, 2].map((id, i) => ({ id, name: 'P' + id, slot: i, bot: false }));
  const g = new WarlockGame({ playerList: () => ps, isBot: () => false, isConnected: () => true, nameOf: () => '', colorOf: () => '#fff', tuning: {} }, { rounds: 3 });
  g.startRound();
  g.obstacles = [];
  g.phase = 'play';
  const me = g.ps.get(1).unit;
  Object.assign(me, { x: 0, y: 0 });
  Object.assign(g.ps.get(2).unit, { x: 30, y: 30 });
  const spells = {};
  for (const [id, d] of Object.entries(SPELLS)) if (id !== 'shield') spells[id] = { castTime: d.castTime || 0, self: SELF.has(id) };
  const pred = new Predictor({ friction: WARLOCK.friction, castPoint: WARLOCK.castPoint, spells });
  const toServer = [], toClient = [], truth = {}, errs = [];
  let tick = 0, offset = null;
  for (let f = 0; f < 240; f++) {
    const tNext = (f + 1) / 60;
    while ((tick + 1) * STEP <= tNext) {
      clock = (tick + 1) * STEP;
      while (toServer.length && toServer[0].at <= clock) g.command(1, toServer.shift().m);
      g.tick(STEP);
      truth[++tick] = [me.x, me.y];
      if (tick % 2 === 0) {
        const s = g.snapshot(1);
        s.tk = tick;
        toClient.push({ at: clock + lat, s: JSON.parse(JSON.stringify(s)) });
      }
    }
    clock = tNext;
    for (const [t, m] of ORDERS) if (Math.abs(t - clock) < 1 / 120) toServer.push({ at: clock + lat, m: pred.order({ t: 'cmd', ...m }) });
    while (toClient.length && toClient[0].at <= clock) {
      const { s } = toClient.shift();
      const sample = clock - s.tk * STEP;
      offset = offset == null ? sample : Math.min(offset, sample);
      pred.snapshot(s);
    }
    if (offset == null) continue;
    const o = pred.frame(clock - offset, 1 / 60);
    // Compared, once the host has got there, with where it put the hero at
    // the moment the prediction is for.
    if (o) errs.push([Math.round((clock - offset + pred.ahead) / STEP), o.x - pred.err.x, o.y - pred.err.y]);
  }
  return errs.filter(([k]) => truth[k]).map(([k, x, y]) => Math.hypot(truth[k][0] - x, truth[k][1] - y)).sort((a, b) => a - b);
}

for (const lat of [0.001, 0.05, 0.12]) {
  test(`prediction tracks the host at ${lat * 1000} ms one-way latency`, () => {
    const e = run(lat);
    assert.ok(e.length > 200, `samples ${e.length}`);
    assert.ok(e[e.length >> 1] < 0.06, `median ${e[e.length >> 1]}`);
    assert.ok(e[Math.floor(e.length * 0.95)] < 0.3, `p95 ${e[Math.floor(e.length * 0.95)]}`);
  });
}
