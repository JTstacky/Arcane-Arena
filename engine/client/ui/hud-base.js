// Shared HUD plumbing, laid out like Warcraft III's: a multiboard in the
// top-right, messages in the lower-left, and a bottom console with the unit
// info panel and the command card. Each game subclasses HudBase and fills
// the panels from its own snapshots.

import { PLAYER_COLORS } from '../../shared/constants.js';
import { escapeHtml } from '../render/world.js';

export const $ = (id) => document.getElementById(id);
export { escapeHtml };

export function fmtTime(t) {
  t = Math.max(0, Math.ceil(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export function hpColor(frac) {
  return frac > 0.6 ? '#2fdc2f' : frac > 0.3 ? '#e8d020' : '#e82020';
}

export class HudBase {
  constructor({ send, onSlot, isHost, getPlayers, myId }) {
    this.send = send;
    this.onSlot = onSlot;
    this.isHost = isHost;
    this.getPlayers = getPlayers;
    this.myId = myId;
    this.cache = {};
    this.tooltip = $('tooltip');
    $('cmdcard').addEventListener('click', (e) => {
      const b = e.target.closest('[data-slot]');
      if (b) this.onSlot(+b.dataset.slot);
    });
    $('centercard').addEventListener('click', (e) => {
      if (e.target.closest('#to-lobby')) this.send({ t: 'toLobby' });
    });
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el) return this.hideTip();
      const [kind, id, lvl] = el.dataset.tip.split(':');
      const html = kind === 'text' ? decodeURIComponent(id) : this.tooltipFor(kind, id, +lvl);
      if (html) this.showTip(html, el);
    });
  }

  // Games override this for their own tooltip kinds (spells, items…).
  tooltipFor() {
    return '';
  }

  showTip(html, el) {
    const t = this.tooltip;
    t.innerHTML = html;
    t.hidden = false;
    const r = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const x = Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2));
    let y = r.top - tr.height - 8;
    if (y < 8) y = r.bottom + 8;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }

  hideTip() {
    this.tooltip.hidden = true;
  }

  reset() {
    this.cache = {};
    for (const id of ['topbar', 'multiboard', 'cmdcard', 'unitinfo', 'centercard', 'shop']) $(id).innerHTML = '';
    $('shop').hidden = true;
    $('centercard').hidden = true;
    this.hideTip();
  }

  set(id, html) {
    if (this.cache[id] === html) return;
    this.cache[id] = html;
    $(id).innerHTML = html;
  }

  playerRow(id) {
    const p = this.getPlayers().find((q) => q.id === +id);
    return { name: escapeHtml(p?.name ?? '?'), color: p ? PLAYER_COLORS[p.slot].hex : '#ccc', bot: p?.bot, connected: p?.connected };
  }

  // Sets the centre card (intro / results / game over). Empty hides it.
  setCenter(html) {
    const cc = $('centercard');
    cc.hidden = !html;
    if (this.cache.center !== html) {
      this.cache.center = html;
      cc.innerHTML = html;
    }
  }

  // Standard game-over card. `extra(st)` adds a column per player.
  overCard(standings, unit, extra = () => '') {
    const w = this.playerRow(standings[0].id);
    return `<div class="card over"><div class="kicker">Victory</div><h1 style="color:${w.color}">${w.name} wins!</h1><table>
      ${standings.map((st, i) => { const p = this.playerRow(st.id); return `<tr><td class="place">#${i + 1}</td><td style="color:${p.color}">${p.name}</td><td><b>${st.score}</b> ${unit}</td>${extra(st)}</tr>`; }).join('')}
      </table>${this.isHost() ? '<button class="btn primary" id="to-lobby">Back to lobby</button>' : '<div class="sub">Waiting for the host…</div>'}</div>`;
  }

  // Standard cooldown button for the command card.
  cmdButton({ slot, icon, key, cd = 0, max = 1, pips = '', tip = '' }) {
    const pct = cd > 0 ? Math.min(100, (cd / max) * 100) : 0;
    return `<div class="cmd ${cd > 0 ? 'cooling' : ''}" data-slot="${slot}" ${tip ? `data-tip="${tip}"` : ''}>
      <span class="icon">${icon}</span><span class="hk">${key}</span>${pips ? `<span class="pips">${pips}</span>` : ''}
      ${cd > 0 ? `<span class="cdsweep" style="--p:${pct}%"></span><span class="cdnum">${Math.ceil(cd)}</span>` : ''}</div>`;
  }
}
