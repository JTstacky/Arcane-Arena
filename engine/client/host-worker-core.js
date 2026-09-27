// Runs inside the hosting player's Web Worker: the same room + game code the
// Node server uses, with connections relayed from the page (the host's own
// client is connection "local"; everyone else is a WebRTC data channel).

import { createHub } from '../server/hub.js';

export function runHostWorker(gameDef) {
  let code = null;
  const hub = createHub(gameDef, { makeCode: () => code });
  const conns = new Map();

  self.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        code = m.code;
        break;
      case 'open': {
        const conn = {
          readyState: 1,
          canDrop: !m.local,
          send: (data, drop) => self.postMessage({ type: 'send', conn: m.conn, data, drop }),
          close: () => {
            conn.readyState = 3;
            self.postMessage({ type: 'close', conn: m.conn });
          },
        };
        // Only the host's own browser may create the room.
        conns.set(m.conn, { conn, h: hub.connect(conn, { canCreate: !!m.local }) });
        break;
      }
      case 'message':
        conns.get(m.conn)?.h.message(m.data);
        break;
      case 'closed': {
        const c = conns.get(m.conn);
        if (c) {
          c.conn.readyState = 3;
          c.h.close();
          conns.delete(m.conn);
        }
        break;
      }
    }
  };

  setInterval(() => hub.sweep(), 10000);
}
