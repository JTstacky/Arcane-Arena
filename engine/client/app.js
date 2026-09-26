// Generic client app: menu → lobby → game. Each game calls startApp() with
// its config (title, HUD class, hotkeys, colours…). The simulation is
// authoritative on the host; this wires network messages to the 3D world,
// the HUD and the input handler.

import './style.css';
import { Net } from './net.js';
import { World, escapeHtml } from './render/world.js';
import { Input } from './input.js';
import { play, unlockAudio, toggleMute, isMuted } from './audio.js';
import { renderShell } from './shell.js';
import { PLAYER_COLORS } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

export function startApp(cfg) {
  const transport = new URLSearchParams(location.search).get('transport') || import.meta.env?.VITE_TRANSPORT || 'p2p';
  renderShell({ ...cfg, p2p: transport === 'p2p' });
  const store = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(`${cfg.id}-${k}`);
      localStorage.setItem(`${cfg.id}-${k}`, v);
    } catch {}
    return null;
  };

  const state = { myId: null, code: null, lobby: null, snap: null, inGame: false, colorPickOpen: false };

  const world = new World($('view'), $('overlay'));
  world.spellColors = cfg.spellColors || {};
  const net = new Net(onMessage, onStatus, { transport, p2p: cfg.p2p });
  const send = (m) => net.send(m);
  const isHost = () => state.lobby && state.lobby.host === state.myId;
  const players = () => state.lobby?.players || [];

  const hud = new cfg.Hud({ send, onSlot: (i) => input.useSlot(i), isHost, getPlayers: players, myId: () => state.myId });
  const input = new Input({
    world,
    send,
    slots: cfg.slots,
    getSnap: () => state.snap,
    getMyId: () => state.myId,
    onChatKey: toggleChat,
    onMenu: () => ($('options').hidden = !$('options').hidden),
  });
  input.quickCast = store('quick') !== '0';
  world.onMessage = (e) => addChat(e.text, { color: e.c, system: !e.c });

  function showBackdrop() {
    world.setMap(cfg.menuMap);
    world.follow = false;
    world.myUnit = null;
    world.zoom = cfg.menuZoom ?? 34;
  }
  showBackdrop();
  window.addEventListener('resize', () => world.resize());

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!state.inGame) {
      const t = now / 1000;
      world.focus.set(Math.cos(t * 0.05) * 4, 0, Math.sin(t * 0.05) * 4);
      cfg.menuFx?.(world, dt);
    }
    input.frame();
    world.render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ----------------------------------------------------------- menu

  $('name').value = store('name') || '';
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) $('code').value = urlCode.toUpperCase();

  function myName() {
    const n = $('name').value.trim().slice(0, 16) || `${cfg.namePlaceholder}${Math.floor(Math.random() * 900 + 100)}`;
    store('name', n);
    return n;
  }

  $('create').onclick = () => {
    unlockAudio();
    play('click');
    net.connect({ t: 'create', name: myName() });
  };
  $('join').onclick = () => {
    unlockAudio();
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Enter a 4-letter game code.');
    play('click');
    net.connect({ t: 'join', code, name: myName() });
  };
  $('code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join').click();
  });
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('code').value.trim() ? $('join') : $('create')).click();
  });

  // ---------------------------------------------------------- lobby

  $('copylink').onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      $('copylink').textContent = 'Copied!';
    } catch {
      prompt('Share this link:', url);
    }
    setTimeout(() => ($('copylink').textContent = 'Copy invite link'), 1500);
  };
  $('leave').onclick = () => leaveToMenu();
  $('addbot').onclick = () => send({ t: 'addBot' });
  $('start').onclick = () => {
    unlockAudio();
    send({ t: 'start' });
  };
  $('players').addEventListener('click', (e) => {
    const kick = e.target.closest('[data-kick]');
    if (kick) return send({ t: 'kick', id: +kick.dataset.kick });
    if (e.target.closest('.swatch.mine')) {
      state.colorPickOpen = !state.colorPickOpen;
      renderLobby();
    }
    const pick = e.target.closest('[data-color]');
    if (pick) {
      state.colorPickOpen = false;
      send({ t: 'color', slot: +pick.dataset.color });
    }
  });
  $('modeopts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-opt]');
    if (b && isHost()) send({ t: 'settings', ...state.lobby.settings, [b.dataset.opt]: +b.dataset.val });
  });

  function leaveToMenu() {
    net.close();
    try {
      sessionStorage.removeItem(`${cfg.id}-seat`);
    } catch {}
    state.lobby = null;
    state.myId = null;
    state.inGame = false;
    input.active = false;
    hud.reset();
    showBackdrop();
    history.replaceState(null, '', location.pathname);
    showScreen('menu');
  }

  function renderLobby() {
    const L = state.lobby;
    if (!L) return;
    $('roomcode').textContent = L.code;
    $('pcount').textContent = `(${L.players.length}/10)`;
    const used = new Set(L.players.map((p) => p.slot));
    $('players').innerHTML = L.players.map((p) => {
      const c = PLAYER_COLORS[p.slot];
      const mine = p.id === state.myId;
      return `<li style="--c:${c.hex}"><span class="swatch ${mine ? 'mine' : ''}" title="${mine ? 'Change colour' : c.name}"></span>
        <span class="nm">${escapeHtml(p.name)}</span>
        ${p.id === L.host ? '<span class="tagx">host</span>' : ''}${p.bot ? '<span class="tagx">bot</span>' : ''}${mine ? '<span class="tagx">you</span>' : ''}${!p.connected ? '<span class="tagx">offline</span>' : ''}
        ${isHost() && !mine ? `<button class="kick" data-kick="${p.id}" title="Remove">✕</button>` : ''}</li>
        ${mine && state.colorPickOpen ? `<div class="colorpick">${PLAYER_COLORS.map((pc, i) => (used.has(i) ? '' : `<i data-color="${i}" style="background:${pc.hex}" title="${pc.name}"></i>`)).join('')}</div>` : ''}`;
    }).join('');
    $('modeopts').innerHTML = cfg.options.map((o) => `<span>${o.label}:</span>${o.values.map((v) => `<button class="btn small ${L.settings[o.key] === v ? 'sel' : ''}" data-opt="${o.key}" data-val="${v}" ${isHost() ? '' : 'disabled'}>${v}</button>`).join('')}`).join('');
    $('addbot').hidden = !isHost();
    $('start').hidden = !isHost();
    $('waithost').hidden = isHost();
    $('hostnote').hidden = !net.isHost;
    world.colors = Object.fromEntries(L.players.map((p) => [p.id, PLAYER_COLORS[p.slot].hex]));
    world.names = Object.fromEntries(L.players.map((p) => [p.id, p.name]));
  }

  // -------------------------------------------------------- network

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        state.myId = m.id;
        state.code = m.code;
        try {
          sessionStorage.setItem(`${cfg.id}-seat`, m.code);
        } catch {}
        world.myId = m.id;
        history.replaceState(null, '', `?room=${m.code}${transport !== 'p2p' && new URLSearchParams(location.search).get('transport') ? `&transport=${transport}` : ''}`);
        break;
      case 'lobby':
        state.lobby = m;
        renderLobby();
        if (!m.inGame && !state.inGame) showScreen('lobby');
        break;
      case 'start':
        state.inGame = true;
        state.snap = null;
        hud.reset();
        showScreen('game');
        world.follow = true;
        world.zoom = cfg.gameZoom ?? 30;
        break;
      case 'map':
        world.setMap(m.map);
        world.follow = true;
        break;
      case 'snap':
        if (!state.inGame) return;
        state.snap = m;
        world.pushSnapshot(m);
        hud.update(m);
        input.active = m.phase === 'play' || m.phase === 'shop';
        break;
      case 'end':
        state.inGame = false;
        state.snap = null;
        input.active = false;
        input.cancelTarget();
        hud.reset();
        showBackdrop();
        showScreen('lobby');
        break;
      case 'chat':
        addChat(m.system ? m.text : `${m.name}: ${m.text}`, { color: m.system ? null : m.c, system: m.system, name: m.name, text: m.text });
        break;
      case 'error':
        toast(m.text);
        play('error');
        break;
      case 'kicked':
        toast('You were removed from the game.');
        leaveToMenu();
        break;
      case 'hostLeft':
        toast('The host has left, so the game has ended.');
        leaveToMenu();
        break;
    }
  }

  function onStatus(s) {
    if (s === 'closed' && state.myId) toast('Connection lost — reconnecting…');
  }

  // Warn a host before closing the tab that runs everyone's game.
  window.addEventListener('beforeunload', (e) => {
    if (net.isHost && state.lobby && state.lobby.players.some((p) => !p.bot && p.id !== state.myId)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------ ui helpers

  function showScreen(name) {
    $('menu').hidden = name !== 'menu';
    $('lobby').hidden = name !== 'lobby';
    $('hud').hidden = name !== 'game';
    $('overlay').hidden = name !== 'game';
    document.body.classList.toggle('inlobby', name !== 'game');
    $('chat').hidden = name === 'menu';
  }

  function addChat(text, { color, system, name, text: body } = {}) {
    const el = document.createElement('div');
    if (system) el.className = 'sys';
    if (name && body != null) {
      el.innerHTML = `<b style="color:${color}">${escapeHtml(name)}:</b> ${escapeHtml(body)}`;
    } else {
      el.textContent = text;
      if (color) el.style.color = color;
    }
    const log = $('chatlog');
    log.appendChild(el);
    while (log.children.length > 12) log.firstChild.remove();
    setTimeout(() => el.classList.add('fade'), 12000);
  }

  function toggleChat() {
    const inp = $('chatinput');
    if (inp.hidden) {
      if ($('menu').hidden === false) return;
      inp.hidden = false;
      inp.focus();
      $('chatlog').querySelectorAll('.fade').forEach((e) => e.classList.remove('fade'));
    } else {
      const text = inp.value.trim();
      if (text) send({ t: 'chat', text });
      inp.value = '';
      inp.hidden = true;
      inp.blur();
    }
  }

  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // Options modal.
  $('hud-menu').onclick = () => ($('options').hidden = false);
  $('opt-close').onclick = () => ($('options').hidden = true);
  if ($('opt-quick')) {
    $('opt-quick').checked = input.quickCast;
    $('opt-quick').onchange = (e) => {
      input.quickCast = e.target.checked;
      store('quick', e.target.checked ? '1' : '0');
    };
  }
  $('opt-mute').checked = isMuted();
  $('opt-mute').onchange = () => toggleMute();

  // Handy for debugging from the console.
  window.game = { send, state, world, net };

  showScreen('menu');
  // A refresh mid-game (same tab) rejoins automatically; the saved token
  // gets the old seat back. Invite links just pre-fill the code.
  let seat = null;
  try {
    seat = sessionStorage.getItem(`${cfg.id}-seat`);
  } catch {}
  if (urlCode && seat === urlCode.toUpperCase() && $('name').value) $('join').click();
  else if (urlCode) $('name').focus();
}
