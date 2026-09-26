// Arcane Arena HUD: round/gold top bar, Warlock multiboard, command card of
// spells with cooldown sweeps, the six-slot inventory and the shop.

import { SPELLS, ITEMS, SLOT_KEYS, COLUMNS, MAX_ITEMS, stat, upgradeCost } from '../shared/warlockData.js';
import { HudBase, $, fmtTime, hpColor } from '../engine/client/ui/hud-base.js';

// A painted icon from art/icons/, falling back to the emoji if it can't load.
export function ico(id, emoji, cls = 'ico') {
  return `<img class="${cls}" src="./art/icons/${id}.webp" alt="" draggable="false" onerror="this.replaceWith(document.createTextNode('${emoji}'))">`;
}

const SPELL_STATS = [
  ['dmg', 'Damage'], ['absorb', 'Absorbs'], ['cd', 'Cooldown', 's'], ['range', 'Range', 'm'], ['aoe', 'Radius', 'm'],
  ['duration', 'Duration', 's'], ['bounces', 'Bounces'], ['life', 'Lifetime', 's'],
];

export function spellTooltip(id, level) {
  const d = SPELLS[id];
  const lv = Math.max(1, level);
  const rows = SPELL_STATS.filter(([k]) => d[k] != null).map(([k, label, unit = '']) => {
    const cur = stat(d, k, lv);
    const next = level > 0 && level < d.maxLevel ? stat(d, k, lv + 1) : null;
    const f = (v) => (Math.round(v * 10) / 10).toString();
    return `<div class="tt-row"><span>${label}</span><b>${f(cur)}${unit}${next != null && next !== cur ? ` <i>→ ${f(next)}${unit}</i>` : ''}</b></div>`;
  });
  return `<div class="tt-title">${ico(id, d.icon, 'ico tt')} ${d.name} ${level ? `<span class="tt-lvl">Level ${level}/${d.maxLevel}</span>` : ''}</div><div class="tt-desc">${d.desc}</div>${rows.join('')}`;
}

export class ArcaneHud extends HudBase {
  constructor(opts) {
    super(opts);
    $('shop').addEventListener('click', (e) => {
      const b = e.target.closest('[data-buy]');
      if (b) this.send({ t: 'cmd', c: 'buy', id: b.dataset.buy });
      if (e.target.closest('#shop-ready')) this.send({ t: 'cmd', c: 'ready' });
    });
    $('shop').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-buy]');
      if (b) this.send({ t: 'cmd', c: 'sell', id: b.dataset.buy });
    });
  }

  tooltipFor(kind, id, lvl) {
    if (kind === 'spell') return spellTooltip(id, lvl);
    if (kind === 'item') {
      const it = ITEMS[id];
      return `<div class="tt-title">${ico(id, it.icon, 'ico tt')} ${it.name} ${lvl ? `<span class="tt-lvl">Level ${lvl}/${it.maxLevel}</span>` : ''}</div><div class="tt-desc">${it.desc}</div><div class="tt-row"><span>Cost</span><b>${it.cost} gold</b></div>`;
    }
    return '';
  }

  update(s) {
    this.snap = s;
    const me = s.players[this.myId()];
    const phaseText = { shop: 'Shopping', play: 'Fight!', roundEnd: 'Round over', over: 'Game over' }[s.phase];
    const timer = s.phase === 'play' || s.phase === 'shop' ? fmtTime(s.timer) : '';
    this.set('topbar', `
      <div class="tb-left">Round: <b>${Math.max(1, s.round + (s.phase === 'shop' ? 1 : 0))}</b>/${s.rounds}</div>
      <div class="tb-mid"><span class="phase">${phaseText}</span> <span class="clock">${timer}</span></div>
      <div class="tb-right">${me ? `<span class="gold" data-tip="text:${encodeURIComponent('Gold. You get more every round.')}">🪙 ${me.g}</span>` : ''}<span class="lava" data-tip="text:${encodeURIComponent('Lava damage per second')}">🔥 ${s.arena.lava}/s</span></div>`);

    const alive = {};
    for (const e of s.ents) if (e.k === 'warlock') alive[e.o] = !e.dead;
    const rows = Object.entries(s.players).sort((a, b) => b[1].sc - a[1].sc || b[1].d - a[1].d);
    // The map's multiboard: Damage (one decimal), K.O.'s and Points.
    this.set('multiboard', `<div class="mb-title">Round: ${Math.max(1, s.round)}/${s.rounds}</div><table>
      <tr><th></th><th>Player</th><th title="Damage dealt">Damage</th><th title="Kills">K.O.'s</th><th title="A kill, an assist and a round win are worth a point each">Points</th></tr>
      ${rows.map(([id, p]) => {
        const r = this.playerRow(id);
        return `<tr class="${alive[id] === false ? 'dead' : ''} ${+id === this.myId() ? 'me' : ''}"><td><i class="sw" style="background:${r.color}"></i></td><td style="color:${r.color}">${r.name}${r.connected === false ? ' ⚠' : ''}</td><td>${(+p.d).toFixed(1)}</td><td>${p.k}</td><td><b>${p.sc}</b></td></tr>`;
      }).join('')}</table>`);

    if (me) this.updateConsole(s, me);
    this.updateShop(s, me);
    this.setCenter(s.phase === 'over' && s.standings ? this.overCard(s.standings, 'points', (st) => `<td>${st.wins} rounds · ${st.kills} kills · ${st.assists} assists · ${st.dmg.toFixed(1)} dmg</td>`) : '');
  }

  updateConsole(s, me) {
    const cds = s.me?.cd || {};
    const cells = [];
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const id = me.sl[i];
      if (!id) {
        cells.push(`<div class="cmd empty"><span class="hk">${SLOT_KEYS[i]}</span></div>`);
        continue;
      }
      const d = SPELLS[id];
      cells.push(this.cmdButton({ slot: i, icon: ico(id, d.icon), key: SLOT_KEYS[i], cd: cds[id] || 0, max: stat(d, 'cd', me.sp[id]), pips: '•'.repeat(me.sp[id]), tip: `spell:${id}:${me.sp[id]}` }));
    }
    this.set('cmdcard', cells.join(''));
    const myUnit = s.ents.find((e) => e.k === 'warlock' && e.o === this.myId());
    const hp = myUnit ? `${Math.ceil(myUnit.hp)} / ${myUnit.mhp}` : '';
    const kp = myUnit?.kp ?? 0;
    const frac = myUnit ? myUnit.hp / myUnit.mhp : 0;
    const inv = [];
    const items = Object.entries(me.it);
    for (let i = 0; i < MAX_ITEMS; i++) {
      const it = items[i];
      inv.push(it ? `<div class="inv" data-tip="item:${it[0]}:${it[1]}">${ico(it[0], ITEMS[it[0]].icon)}<span class="lv">${it[1]}</span></div>` : '<div class="inv empty"></div>');
    }
    const r = this.playerRow(this.myId());
    this.set('unitinfo', `
      <div class="portrait" style="--c:${r.color}">${ico('portrait_warlock', '🧙')}</div>
      <div class="uinfo"><div class="uname2" style="color:${r.color}">${r.name}</div><div class="utitle">Warlock</div>
        <div class="bighp"><div style="width:${frac * 100}%;background:${hpColor(frac)}"></div><span>${hp}</span></div>
        <div class="kbline" data-tip="text:${encodeURIComponent('<div class=tt-title>Damage taken</div><div class=tt-desc>The original shows this on the mana bar. A hit of D damage pushes you with D × (100 + damage taken), so every point you take this round makes you fly 1% further. Lava adds half its damage.</div>')}">Damage taken <b>${(+kp).toFixed(1)}</b> · knockback <b>+${Math.round(kp)}%</b></div></div>
      <div class="inventory">${inv.join('')}</div>`);
  }

  updateShop(s, me) {
    const shop = $('shop');
    shop.hidden = s.phase !== 'shop' || !me;
    if (shop.hidden) return;
    const card = (id, d, lvl, cost, can, note = '') => `<button class="shopcard ${lvl ? 'owned' : ''} ${can ? '' : 'disabled'}" data-buy="${id}" data-tip="${SPELLS[id] ? 'spell' : 'item'}:${id}:${lvl}">
        <span class="icon">${ico(id, d.icon)}</span><span class="nm">${d.name}</span>
        <span class="pips">${lvl ? '●'.repeat(lvl) + '○'.repeat(d.maxLevel - lvl) : note}</span>
        <span class="cost">${lvl >= d.maxLevel ? 'MAX' : `${lvl ? '▲' : ''} 🪙${cost}`}</span></button>`;
    const spellCard = (id) => {
      const d = SPELLS[id];
      const lvl = me.sp[id] || 0;
      const cost = upgradeCost(d, lvl);
      const holder = me.sl[d.slot];
      const note = !lvl && holder && holder !== id ? `replaces ${SPELLS[holder].name}` : '';
      return card(id, d, lvl, cost, lvl < d.maxLevel && me.g >= cost, note);
    };
    const byCol = (slot) => Object.keys(SPELLS).filter((id) => SPELLS[id].slot === slot);
    const cols = COLUMNS.map((c) => `<div class="shopcol"><div class="colhead"><b>${SLOT_KEYS[c.slot]}</b> ${c.name}</div>${byCol(c.slot).map(spellCard).join('')}</div>`);
    const itemCards = Object.entries(ITEMS).map(([id, d]) => {
      const lvl = me.it[id] || 0;
      const full = !lvl && Object.keys(me.it).length >= MAX_ITEMS;
      return card(id, d, lvl, d.cost, lvl < d.maxLevel && !full && me.g >= d.cost);
    });
    const readyCount = Object.values(s.players).filter((p) => p.rd).length;
    this.set('shop', `
      <div class="shop-head"><h2>Goblin Merchant</h2><div class="shop-gold">🪙 <b>${me.g}</b> gold</div><div class="shop-timer">Next round in <b id="shop-t"></b>s</div></div>
      <h3>Spells <small>— one per column. Buy to learn, buy again to upgrade. <span class="mouseonly">Right-click</span><span class="touchonly">Long-press</span> an owned card to sell for half.</small></h3>
      <div class="shopcols">
        <div class="shopcol"><div class="colhead"><b>${SLOT_KEYS[SPELLS.fireball.slot]}</b> / <b>${SLOT_KEYS[SPELLS.scourge.slot]}</b> Basics</div>${spellCard('fireball')}${spellCard('scourge')}</div>
        ${cols.join('')}
      </div>
      <h3>Items <small>(${Object.keys(me.it).length}/${MAX_ITEMS} slots)</small></h3>
      <div class="shopgrid">${itemCards.join('')}</div>
      <div class="shop-foot"><span id="shop-rc"></span>
        <button id="shop-ready" class="btn ${me.rd ? 'on' : 'primary'}">${me.rd ? 'Waiting… (click to unready)' : 'Ready!'}</button></div>`);
    // Live values are patched in place so the cards aren't rebuilt mid-click.
    $('shop-t').textContent = Math.ceil(s.timer);
    $('shop-rc').textContent = `${readyCount}/${Object.keys(s.players).length} ready`;
  }
}
