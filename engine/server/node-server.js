// Optional dedicated server: serves a built game from disk and hosts rooms
// over a WebSocket endpoint (/ws). Not needed for the static peer-to-peer
// build, but handy for development and for self-hosting.
//
// Each game has a tiny entry (games/<id>/server.js) that calls startServer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createHub } from './hub.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function startServer({ gameDef, distDir, port = +process.env.PORT || 3000 }) {
  const DIST = path.resolve(distDir);
  const hub = createHub(gameDef);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, game: gameDef.id, rooms: hub.rooms.size }));
      return;
    }
    let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`${gameDef.id} is not built. Run the build first.`);
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const h = hub.connect(ws);
    ws.on('message', (raw) => h.message(raw.toString()));
    ws.on('close', () => h.close());
  });

  // Drop dead connections and empty lobbies.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000).unref();
  setInterval(() => hub.sweep(), 10000).unref();

  server.listen(port, () => console.log(`${gameDef.title} server listening on http://localhost:${port}`));
  return server;
}
