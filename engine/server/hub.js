// Connection hub: turns incoming connections into room members. Shared by
// the Node WebSocket server and the in-browser host used for peer-to-peer
// games, so both run exactly the same room and game code.
//
// A connection is anything with send(string), close() and readyState (1 =
// open), which a `ws` WebSocket already is.

import { Room } from './room.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomCode() {
  return Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
}

// options.makeCode: () => code for new rooms (p2p hosts use their fixed code)
export function createHub(gameDef, { makeCode } = {}) {
  const rooms = new Map();

  function newCode() {
    if (makeCode) return makeCode();
    let code;
    do code = randomCode();
    while (rooms.has(code));
    return code;
  }

  // Returns handlers for one connection. `canCreate` is false for remote
  // peers in a p2p game — only the hosting browser may create the room.
  function connect(conn, { canCreate = true } = {}) {
    let room = null;
    let player = null;
    const fail = (text) => conn.send(JSON.stringify({ t: 'error', text }));

    return {
      message(raw) {
        // "a<seq>": the player has snapshot <seq> (shared/snapcodec.js).
        if (raw[0] === 'a') return conn.ack?.(+raw.slice(1));
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (!m || typeof m.t !== 'string') return;
        if (!player) {
          const name = String(m.name || '').slice(0, 16).trim();
          const token = String(m.token || '').slice(0, 64);
          if (m.t === 'create' && canCreate) {
            const code = newCode();
            room = rooms.get(code) || new Room(code, (r) => rooms.delete(r.code), gameDef);
            rooms.set(code, room);
          } else if (m.t === 'join') {
            room = rooms.get(String(m.code || '').toUpperCase().trim());
            if (!room) return fail('No game with that code.');
          } else return;
          const res = room.join(conn, name, token);
          if (res.error) {
            room = null;
            return fail(res.error);
          }
          player = res;
          return;
        }
        room.handle(player, m);
      },
      close() {
        if (room && player && player.ws === conn) room.leave(player);
      },
    };
  }

  // Lobbies everyone has left are closed after a grace period.
  function sweep() {
    for (const room of rooms.values()) {
      if (!room.game && room.emptySince && Date.now() - room.emptySince > 30_000) room.close();
      if (!room.game && room.players.size === 0) rooms.delete(room.code);
    }
  }

  return { connect, rooms, sweep };
}
