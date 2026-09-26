// Arcane Arena client entry.
import { startApp } from '../engine/client/app.js';
import { ArcaneHud } from './hud.js';
import { SPELLS, SLOT_KEYS, stat } from '../shared/warlockData.js';
import { meta } from '../meta.js';
import { CAM_DISTANCE } from '../engine/client/render/world.js';

const SELF_CAST = new Set(['shield', 'windwalk', 'rush', 'scourge']);

startApp({
  ...meta,
  tagline: 'Knock rival warlocks into the lava. A remake of the classic Warcraft III custom map Warlock.',
  blurb: 'Last warlock standing wins the round. Spend gold on spells between rounds; the more damage you take, the further you fly.',
  namePlaceholder: 'Warlock',
  pills: ['🔥 <b>Fireball, Lightning, Meteor…</b> — 15 spells to buy and upgrade', '🌋 <b>Shrinking arena</b> — the lava closes in every round', '⚔️ <b>Real WC3 feel</b> — movement, casting and knockback measured in Warcraft III'],
  keysHelp: [
    '<b>Right-click</b> move (hold to keep moving)',
    `<b>${SLOT_KEYS.join(' ')}</b> spells, then <b>left-click</b> a target`,
    '<b>S</b> stop · <b>Esc</b> or <b>right-click</b> cancel targeting',
    '<b>Space</b> centre camera · <b>Y</b> camera follows you',
    '<b>Screen edges</b> / <b>arrows</b> scroll · <b>wheel</b> zoom',
    '<b>Enter</b> chat · <b>F8</b> Movement Lab overlay',
    'Host chat commands: <b>-turnrate 0.6</b> · <b>-propwindow 60</b> · <b>-castpoint 0.3</b> · <b>-tuning reset</b>',
  ],
  quickCast: true,
  Hud: ArcaneHud,
  spellColors: Object.fromEntries(Object.entries(SPELLS).map(([id, d]) => [id, d.color])),
  slots: {
    slotForKey: (e) => SLOT_KEYS.indexOf(e.key.toUpperCase()),
    action(i, snap, myId) {
      const me = snap.players?.[myId];
      const spell = me?.sl[i];
      if (!spell || snap.phase !== 'play') return null;
      if ((snap.me?.cd?.[spell] || 0) > 0) return { error: true };
      if (SELF_CAST.has(spell)) return { self: spell };
      const d = SPELLS[spell];
      return { target: spell, name: d.name, range: d.range != null ? stat(d, 'range', me.sp[spell]) : null, aoe: d.aoe != null ? stat(d, 'aoe', me.sp[spell]) : null };
    },
  },
  menuMap: { theme: 'lava', floor: { shape: 'disc', r: 15 }, bounds: 40, props: [] },
  menuFx(world) {
    if (Math.random() < 0.02) {
      const a = Math.random() * 6.28;
      world.handleEvent({ k: 'boom', x: Math.cos(a) * 10, y: Math.sin(a) * 10, r: 1.5, c: '#ff7a1a' });
    }
  },
  gameZoom: CAM_DISTANCE, // WC3's default camera distance
  p2p: {
    prefix: 'tenggames-arcane-arena',
    createWorker: () => new Worker(new URL('./host-worker.js', import.meta.url), { type: 'module' }),
  },
  otherGame: { title: "Hammerguy's Party", href: '/hammerguys-party/' },
  homeHref: '/',
});
