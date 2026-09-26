// Dedicated server entry: serves the built client and hosts rooms over /ws.
import { fileURLToPath } from 'node:url';
import { startServer } from './engine/server/node-server.js';
import { gameDef } from './game.js';

startServer({ gameDef, distDir: fileURLToPath(new URL('./dist/', import.meta.url)) });
