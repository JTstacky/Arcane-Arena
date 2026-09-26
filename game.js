// Arcane Arena — game definition used by the room host (Node server or the
// hosting player's browser).
import { WarlockGame } from './server/warlock.js';
import { meta } from './meta.js';

export const gameDef = {
  ...meta,
  Game: WarlockGame,
  options: Object.fromEntries(meta.options.map((o) => [o.key, o.values])),
};
