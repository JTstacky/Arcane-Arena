// End-to-end networking test: boots the real server, connects two clients,
// joins the same room by code, starts a game and checks both receive
// snapshots containing both players.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3000 + Math.floor(Math.random() * 1000) + 1000;

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  return {
    ws,
    msgs,
    open: () => new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 5000) => new Promise((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) return resolve(found);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms);
    }),
  };
}

test('two clients join a room and play', async () => {
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.on('data', r));
  try {
    const a = client();
    await a.open();
    a.send({ t: 'create', name: 'Alice', token: 'a' });
    const welcome = await a.wait((m) => m.t === 'welcome');
    const b = client();
    await b.open();
    b.send({ t: 'join', code: welcome.code, name: 'Bob', token: 'b' });
    await b.wait((m) => m.t === 'welcome');
    await a.wait((m) => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'settings', rounds: 5 });
    a.send({ t: 'start' });
    const sa = await a.wait((m) => m.t === 'snap');
    const sb = await b.wait((m) => m.t === 'snap');
    assert.equal(sa.ents.filter((e) => e.k === 'warlock').length, 2);
    assert.equal(sb.ents.filter((e) => e.k === 'warlock').length, 2);
    assert.equal(sa.phase, 'shop');
    // Bob buys a spell and readies; state is reflected in snapshots.
    b.send({ t: 'cmd', c: 'buy', id: 'homing' });
    await b.wait((m) => m.t === 'snap' && m.players[Object.keys(m.players)[1]]?.sp?.homing === 1);
    // Reconnect: Bob drops and comes back with the same token.
    b.ws.close();
    const b2 = client();
    await b2.open();
    b2.send({ t: 'join', code: welcome.code, name: 'Bob', token: 'b' });
    await b2.wait((m) => m.t === 'start');
    const snap = await b2.wait((m) => m.t === 'snap');
    assert.ok(snap.me?.uid, 'reconnected player controls their warlock again');
    a.ws.close();
    b2.ws.close();
  } finally {
    server.kill();
  }
});

test('joining a missing room gives an error', async () => {
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT + 1) } });
  await new Promise((r) => server.stdout.on('data', r));
  try {
    const ws = new WebSocket(`ws://localhost:${PORT + 1}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'join', code: 'ZZZZ', name: 'x', token: 'x' }));
    const m = await new Promise((r) => ws.on('message', (raw) => r(JSON.parse(raw))));
    assert.equal(m.t, 'error');
    ws.close();
  } finally {
    server.kill();
  }
});
