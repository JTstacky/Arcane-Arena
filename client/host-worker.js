// Web Worker entry for the hosting player's browser (peer-to-peer games).
import { runHostWorker } from '../engine/client/host-worker-core.js';
import { gameDef } from '../game.js';

runHostWorker(gameDef);
