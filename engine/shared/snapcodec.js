// Snapshot compression, shared by the host (encoder) and players (decoder).
//
// Most of a snapshot is the same as the one before it, so each snapshot is
// sent as the difference from one the player is known to have (its
// "baseline"). It works on any JSON snapshot — no per-game schema — so a new
// game gets it for free. Two rules for snapshots:
//   - Entities in arrays should have an `id` so they're matched by id.
//   - One-shot events go in `snap.ev`; they're delivered exactly once, in
//     order, even when snapshots are lost, and never diffed.
//
// A player knows a snapshot either because the transport can't lose it
// (reliable channel or WebSocket: every snapshot sent counts), or because the
// player acknowledged it (the lossy WebRTC channel: the encoder only uses
// snapshots the player said it has). Events are repeated in every snapshot
// until one carrying them is known to have arrived.
//
// Wire format (JSON text): {t:'d', s, b?, d, e?, a?}
//   s  sequence number     b  baseline sequence (absent: d is the whole snapshot)
//   d  the snapshot or its patch against baseline b
//   e  [first event sequence, ...events]    a  1 = please acknowledge ("a<s>")
//
// Patch nodes (diff/patch): a primitive replaces the value; an object patches
// an object key by key ("-": keys removed); arrays are tagged:
//   [0, v]                               replace with v
//   [1, [id, node, …], [added…], [removed ids…], order?]   arrays of {id} objects
//   [2, length, i, node, i, node, …]      any other array, by index

// A player that stops acknowledging (a lossy channel, or a page that stalls
// for a few seconds while it builds a new map) keeps getting deltas against
// its last acknowledged snapshot for MAX_AGE snapshots (~6 s); after that,
// whole snapshots until it catches up. The decoder keeps enough history.
const MAX_AGE = 100;
const HISTORY = 128;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byId = (arr) => arr.length > 0 && arr.every((e) => isObj(e) && e.id != null);

// Returns a patch node turning a into b, or undefined if they're equal.
export function diff(a, b) {
  if (a === b) return undefined;
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return [0, b];
    return diffArray(a, b);
  }
  if (isObj(b)) {
    if (!isObj(a)) return [0, b];
    let out;
    for (const k in b) {
      const n = diff(a[k], b[k]);
      if (n !== undefined) (out ||= {})[k] = n;
    }
    for (const k in a) if (!(k in b)) ((out ||= {})['-'] ||= []).push(k);
    return out;
  }
  return b; // a primitive, including null
}

function diffArray(a, b) {
  if (byId(b) && (a.length === 0 || byId(a))) {
    const old = new Map(a.map((e) => [e.id, e]));
    const upd = [];
    const add = [];
    const keep = new Set();
    for (const e of b) {
      const o = old.get(e.id);
      if (o) {
        keep.add(e.id);
        const n = diff(o, e);
        if (n !== undefined) upd.push(e.id, n);
      } else add.push(e);
    }
    const del = a.filter((e) => !keep.has(e.id)).map((e) => e.id);
    // Default order: the survivors in their old order, then the new ones.
    const order = b.map((e) => e.id);
    const def = a.filter((e) => keep.has(e.id)).map((e) => e.id).concat(add.map((e) => e.id));
    const same = order.every((id, i) => id === def[i]);
    if (!upd.length && !add.length && !del.length && same) return undefined;
    const node = [1, upd, add, del];
    if (!same) node.push(order);
    return node;
  }
  const node = [2, b.length];
  for (let i = 0; i < b.length; i++) {
    const n = i < a.length ? diff(a[i], b[i]) : wrap(b[i]);
    if (n !== undefined) node.push(i, n);
  }
  return node.length === 2 && a.length === b.length ? undefined : node;
}

// A value as a "replace" node.
const wrap = (v) => (v !== null && typeof v === 'object' ? [0, v] : v);

// Applies a patch node to a (which is not modified) and returns the result.
// Unchanged parts are shared with a.
export function patch(a, n) {
  if (n === undefined) return a;
  if (Array.isArray(n)) {
    if (n[0] === 0) return n[1];
    if (n[0] === 1) {
      const [, upd, add, del, order] = n;
      const cur = new Map((a || []).map((e) => [e.id, e]));
      for (const id of del) cur.delete(id);
      for (let i = 0; i < upd.length; i += 2) cur.set(upd[i], patch(cur.get(upd[i]), upd[i + 1]));
      for (const e of add) cur.set(e.id, e);
      return order ? order.map((id) => cur.get(id)) : [...cur.values()];
    }
    const out = (a || []).slice(0, n[1]);
    for (let i = 2; i < n.length; i += 2) out[n[i]] = patch(out[n[i]], n[i + 1]);
    return out;
  }
  if (isObj(n)) {
    const out = { ...(isObj(a) ? a : {}) };
    for (const k in n) if (k !== '-') out[k] = patch(out[k], n[k]);
    if (n['-']) for (const k of n['-']) delete out[k];
    return out;
  }
  return n;
}

export class SnapEncoder {
  // ackOnSend: the transport never loses messages (see above).
  constructor({ ackOnSend = true } = {}) {
    this.ackOnSend = ackOnSend;
    this.seq = 0;
    this.base = null; // sequence of the baseline
    this.hist = new Map(); // seq -> { state, eTop }
    this.events = []; // [eventSeq, event] not yet known delivered
    this.eseq = 0;
  }

  // Events from a snapshot that isn't being sent: they go with the next one.
  hold(ev) {
    for (const e of ev || []) this.events.push([this.eseq++, e]);
  }

  // Returns { data, full }: the message text, and whether it's a whole
  // snapshot (worth sending reliably, as the next ones build on it).
  encode(snap) {
    const { ev, ...rest } = snap;
    this.hold(ev);
    // A deep copy: games may reuse objects and arrays between snapshots.
    const json = JSON.stringify(rest);
    const state = JSON.parse(json);
    const s = ++this.seq;
    const msg = { t: 'd', s };
    const base = this.base != null && s - this.base <= MAX_AGE ? this.hist.get(this.base) : null;
    let full = true;
    if (base) {
      const d = diff(base.state, state) ?? {};
      const ds = JSON.stringify(d);
      if (ds.length < json.length) {
        msg.b = this.base;
        msg.d = d;
        full = false;
      }
    }
    if (full) msg.d = state;
    if (this.events.length) msg.e = [this.events[0][0], ...this.events.map((x) => x[1])];
    if (!this.ackOnSend) msg.a = 1;
    this.hist.set(s, { state, eTop: this.eseq });
    for (const k of this.hist.keys()) {
      if (k > s - HISTORY) break;
      if (k !== this.base) this.hist.delete(k);
    }
    const data = JSON.stringify(msg);
    if (this.ackOnSend) this.ack(s);
    return { data, full };
  }

  // The player has snapshot s.
  ack(s) {
    const h = this.hist.get(s);
    if (!h || (this.base != null && s <= this.base)) return;
    this.base = s;
    while (this.events.length && this.events[0][0] < h.eTop) this.events.shift();
    for (const k of this.hist.keys()) {
      if (k >= s) break;
      this.hist.delete(k);
    }
  }
}

export class SnapDecoder {
  constructor() {
    this.hist = new Map();
    this.last = 0; // newest sequence decoded
    this.eTop = 0; // next event sequence expected
  }

  // Returns the snapshot, or null for one that's out of date or can't be
  // decoded (its baseline was lost); the next one will do.
  decode(msg) {
    if (msg.s <= this.last) return null;
    let state;
    if (msg.b == null) state = msg.d;
    else {
      const base = this.hist.get(msg.b);
      if (!base) return null;
      state = patch(base, msg.d);
    }
    this.last = msg.s;
    this.hist.set(msg.s, state);
    for (const k of this.hist.keys()) {
      if (k > msg.s - HISTORY) break;
      this.hist.delete(k);
    }
    const ev = [];
    if (msg.e) {
      const first = msg.e[0];
      for (let i = 1; i < msg.e.length; i++) if (first + i - 1 >= this.eTop) ev.push(msg.e[i]);
      this.eTop = Math.max(this.eTop, first + msg.e.length - 1);
    }
    // The game gets its own copy: history is shared between snapshots.
    const out = structuredClone(state);
    out.ev = ev;
    return out;
  }
}
