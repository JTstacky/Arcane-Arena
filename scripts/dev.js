// Runs the dev game server (rooms over WebSocket) plus Vite with hot reload.
// Open http://localhost:5173; add ?transport=p2p to try peer-to-peer.
import { spawn } from 'node:child_process';

const env = { ...process.env, PORT: '3000', GAME_PORT: '3000', VITE_TRANSPORT: process.env.VITE_TRANSPORT || 'ws' };
const procs = [
  spawn(process.execPath, ['--watch', 'server.js'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
