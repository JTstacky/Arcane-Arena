// Snapshot compression: every snapshot decodes to exactly what was sent,
// events arrive exactly once and in order, with or without lost snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diff, patch, SnapEncoder, SnapDecoder } from '../engine/shared/snapcodec.js';

// A made-up game: entities come and go and move, arrays and keys change.
function* game(n) {
  const ents = new Map();
  let nextId = 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let tk = 0; tk < n; tk++) {
    if (rnd() < 0.2) ents.set(nextId, { id: nextId++, k: rnd() < 0.5 ? 'unit' : 'missile', x: 0, y: 0 });
    for (const [id, e] of ents) {
      if (rnd() < 0.03) ents.delete(id);
      else if (rnd() < 0.7) e.x = Math.round((e.x + rnd() - 0.5) * 100) / 100;
      if (rnd() < 0.05) e.fx = rnd() < 0.5 ? ['shield'] : undefined;
    }
    const list = [...ents.values()].map((e) => ({ ...e }));
    if (rnd() < 0.1) list.reverse();
    const snap = {
      t: 'snap',
      tk,
      phase: tk < n / 2 ? 'shop' : 'play',
      ents: list,
      scores: [tk % 3, 2, rnd() < 0.1 ? 5 : 1].slice(0, 2 + (tk % 2)),
      me: tk % 10 === 0 ? null : { cd: { q: tk % 4 } },
      ev: rnd() < 0.3 ? [{ k: 'boom', n: tk }] : [],
    };
    if (tk % 7 === 0) snap.extra = { a: [1, { b: 2 }] };
    yield snap;
  }
}

const strip = ({ ev, ...s }) => JSON.parse(JSON.stringify(s));

test('diff/patch round trip', () => {
  const a = { x: 1, arr: [{ id: 1, v: 1 }, { id: 2, v: 2 }], list: [1, 2, 3], gone: 1, o: { p: [0] } };
  const b = { x: 2, arr: [{ id: 3, v: 3 }, { id: 1, v: 5 }], list: [1, 9], o: { p: [0, { q: 1 }] }, n: null };
  assert.deepEqual(patch(a, diff(a, b)), b);
  assert.equal(diff(b, structuredClone(b)), undefined);
  assert.deepEqual(a.arr[0], { id: 1, v: 1 }, 'patch leaves the baseline alone');
});

for (const [name, loss] of [['reliable', 0], ['lossy', 0.25]]) {
  test(`stream decodes exactly (${name})`, () => {
    const enc = new SnapEncoder({ ackOnSend: loss === 0 });
    const dec = new SnapDecoder();
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sent = [];
    const got = [];
    let decoded = 0;
    for (const snap of game(400)) {
      const orig = strip(snap);
      for (const e of snap.ev) sent.push(e.n);
      const { data, full } = enc.encode(snap);
      if (!full && rnd() < loss) continue;
      const out = dec.decode(JSON.parse(data));
      if (!out) continue;
      decoded++;
      for (const e of out.ev) got.push(e.n);
      assert.deepEqual(strip(out), orig);
      if (JSON.parse(data).a) enc.ack(JSON.parse(data).s);
    }
    assert.deepEqual(got, sent.slice(0, got.length), 'events exactly once, in order');
    assert.ok(got.length >= sent.length - 3);
    assert.ok(decoded > 400 * (1 - loss) - 20);
  });
}

test('skipped snapshots keep their events', () => {
  const enc = new SnapEncoder();
  const dec = new SnapDecoder();
  dec.decode(JSON.parse(enc.encode({ t: 'snap', tk: 1, ev: [{ n: 1 }] }).data));
  enc.hold([{ n: 2 }]); // not sent: the connection was busy
  const out = dec.decode(JSON.parse(enc.encode({ t: 'snap', tk: 3, ev: [{ n: 3 }] }).data));
  assert.deepEqual(out.ev.map((e) => e.n), [2, 3]);
});
