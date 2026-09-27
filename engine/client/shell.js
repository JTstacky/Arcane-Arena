// Builds the page's static UI (menu, lobby, HUD skeleton, chat, options) from
// a game's config, so each game's index.html stays a one-line shell.

import { escapeHtml } from './render/world.js';
import { TOUCH } from './device.js';

export function renderShell(cfg) {
  const keys = (TOUCH && cfg.touchHelp ? cfg.touchHelp : cfg.keysHelp).map((k) => `<div>${k}</div>`).join('');
  document.body.insertAdjacentHTML('afterbegin', `
    <canvas id="view"></canvas>
    <div id="overlay"></div>

    <div id="hud" hidden>
      <div id="topbar"></div>
      <div id="multiboard"></div>
      <div id="messages"></div>
      <div id="centercard" hidden></div>
      <div id="shop" hidden></div>
      <div id="console">
        <div id="unitinfo"></div>
        <div id="cmdcard"></div>
      </div>
      <div id="targethint" hidden></div>
      <div id="spectate" hidden><button id="spec-prev" title="Previous player">◀</button><span id="spec-label"></span><button id="spec-next" title="Next player">▶</button></div>
      <div id="errmsg" hidden></div>
      <div id="labinfo" hidden></div>
      <button id="hud-menu" class="iconbtn" title="Options">⚙</button>
    </div>

    ${cfg.homeHref ? `<a id="homelink" href="${cfg.homeHref}">← Teng Games</a>` : ''}
    <section id="menu" class="screen">
      <div class="panel title-panel">
        <div class="wip" title="This game is still being built. Expect bugs and changes.">Early access · work in progress · ${escapeHtml(cfg.version)}</div>
        <h1 class="logo">${escapeHtml(cfg.title)}</h1>
        <p class="tag">${escapeHtml(cfg.tagline)}</p>
        <label class="field">Your name <input id="name" maxlength="16" placeholder="${escapeHtml(cfg.namePlaceholder)}" autocomplete="off" /></label>
        <div class="row">
          <button id="create" class="btn primary big">Host a game</button>
        </div>
        <div class="row join">
          <input id="code" maxlength="4" placeholder="CODE" autocomplete="off" />
          <button id="join" class="btn big">Join</button>
        </div>
        <div class="modes">${cfg.pills.map((p) => `<div class="mode-pill">${p}</div>`).join('')}</div>
        <p class="fine">Play solo against bots, or host and share the code or link with friends.${cfg.p2p ? ' The host’s browser runs the game — keep that tab open.' : ''}</p>
        ${cfg.otherGame ? `<p class="fine other">Also on Teng Games: <a href="${cfg.otherGame.href}">${escapeHtml(cfg.otherGame.title)}</a>${cfg.homeHref ? ` · <a href="${cfg.homeHref}">All games</a>` : ''}</p>` : ''}
      </div>
    </section>

    <section id="lobby" class="screen" hidden>
      <div class="panel lobby-panel">
        <div class="lobby-head">
          <div>
            <div class="kicker">Game code</div>
            <div id="roomcode" class="roomcode">----</div>
          </div>
          <button id="copylink" class="btn">Copy invite link</button>
          <button id="leave" class="btn ghost">Leave</button>
        </div>
        <div class="lobby-body">
          <div class="col">
            <h3>Players <span id="pcount"></span></h3>
            <ul id="players"></ul>
            <button id="addbot" class="btn small">+ Add bot</button>
          </div>
          <div class="col">
            <h3>${escapeHtml(cfg.title)}</h3>
            <p class="fine blurb">${escapeHtml(cfg.blurb)}</p>
            <div id="modeopts"></div>
            <button id="start" class="btn primary big">Start game</button>
            <div id="waithost" class="fine" hidden>Waiting for the host to start…</div>
            <div id="hostnote" class="fine" hidden>You’re hosting: the game runs in this tab, so keep it open until the match is over.<span class="touchonly"> On a phone, switching apps or locking the screen pauses the match for everyone.</span></div>
          </div>
        </div>
      </div>
    </section>

    <div id="chat">
      <div id="chatlog"></div>
      <input id="chatinput" maxlength="200" placeholder="Press Enter to chat" autocomplete="off" hidden />
    </div>

    <div id="options" class="modal" hidden>
      <div class="panel">
        <h2>Options</h2>
        ${cfg.quickCast ? '<label class="check"><input type="checkbox" id="opt-quick" /> Quick-cast (spells fire at the cursor on keypress)</label>' : ''}
        <label class="check"><input type="checkbox" id="opt-mute" /> Mute sound (M)</label>
        <div class="keys">${keys}</div>
        <button id="opt-close" class="btn primary">Close</button>
      </div>
    </div>

    <div id="tooltip" hidden></div>
    <div id="toast" hidden></div>`);
}
