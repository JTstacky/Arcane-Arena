# 🔥 Arcane Arena

> **Early access.** The game is playable but still being built. Expect bugs, balance changes and missing spells.

Arcane Arena is a browser remake of **Warlock**, the classic Warcraft III custom map. Every player is a warlock on a stone platform surrounded by lava:

- **Knockback kills, not spells.** Spells do little damage but knock you back, and every point of damage you take makes the next hit throw you further. The lava does the killing.
- **Shrinking arena.** The platform loses a tile every 15·√alive seconds.
- **Rounds and shop.** The last warlock standing wins the round. Kills, assists and round wins score a point each. Between rounds you buy and upgrade spells and items.

![Arcane Arena](docs/screenshot.png)

**Play:** https://tenggames.com.au/arcane-arena/

## Features

- **Up to 10 players online.** Peer-to-peer multiplayer with no game server: the host's browser runs the match, and friends join with a 4-letter code or an invite link.
- **Bots** to fill the lobby or practise against.
- **Warcraft III feel, measured in the real engine** ([docs/wc3-observations.md](docs/wc3-observations.md)):
  - The simulation runs in WC3's 0.03 s steps.
  - Movement: the heading turns 0.6 rad per step, and the unit walks only when its heading before the step is within the 60° propulsion window. Full speed at once, and it stops dead about 11 units short of the click.
  - The drawn model turns more slowly than the unit steers, so after an about-face the warlock slides backwards for a moment, as in WC3.
  - Casting: the warlock turns until it faces the target exactly, the spell goes off at once, then a 0.3 s cast point locks it. A right-click during the cast point waits for it instead of cancelling. The cooldown starts after the cast point.
  - Knockback: a hit of D damage adds D·(100+M) units/s, where M is the damage taken this round including that hit. It decays ×0.96 per step, so a Fireball slides a fresh warlock 539 units. Warlocks that collide swap velocities.
  - The original's 100-HP scale. Lava is checked every 0.1 s.
  - The default WC3 camera: distance 1650, 56° down. It doesn't follow you: scroll with the screen edges or arrow keys, and press Space to centre.
  - Green order-confirmation arrows, the blue targeting reticle, and "Spell is not ready yet."
  - For tuning: a Movement Lab overlay (F8) and host commands (`-turnrate`, `-propwindow`, `-castpoint`). `npm test` checks the engine against the measured numbers.
- **Spells:**
  - Fireball and Self-Explode (the original's Scourge: a close-range blast that costs you 10 health), which everyone starts with;
  - one spell per shop column: Lightning, Homing, Boomerang, Teleport, Thrust, Swap, Drain, Bouncer, Meteor, Windwalk, Shield, Rush, Gravity, Link;
  - items;
  - Shield is an autocast: it goes up by itself when a projectile is about to hit you and reflects it;
  - rock obstacles on the arena, off by default (a lobby option), and Lightning detonating a Fireball.
- **Phones:** joystick to walk, tap to throw a fireball, spell buttons arm a spell for one tap; the camera follows at a fixed distance.
- **Graphics and sound** are generated in code with Three.js and WebAudio. There are no asset files.

## Development

```bash
npm install
npm run dev        # dev server with hot reload → http://localhost:5173
npm test           # headless bot games + multiplayer test
npm run build      # static site → dist/
```

`npm run serve` builds and runs the optional Node server, which hosts rooms over WebSockets. You can also use the `Dockerfile` for that. The published site doesn't need it.

## Deployment

The game is published at **tenggames.com.au/arcane-arena/** as part of the Teng Games site ([JTstacky/Chess-tutor](https://github.com/JTstacky/Chess-tutor)). As with the site's other games, the built files are committed into that repo at `public/arcane-arena/`.

On every push to `main`, `.github/workflows/publish.yml` tests and builds, then commits the build to the site as "Arcane Arena: update to the latest build". The site's own deploy then publishes it.

That step needs the repository secret `SITE_DEPLOY_TOKEN`: a fine-grained token with access to Chess-tutor only and **Contents: Read and write**. Without the secret, run `scripts/update-games.sh` in Chess-tutor and commit the result.

## How it works

```
client/   game client: entry (main.js), HUD + shop (hud.js), host worker
server/   warlock.js: rules, spells, knockback, lava, shop, bots
shared/   warlockData.js: spell and item tables (used by server and client)
engine/   shared engine (also used by Hammerguy's Party):
          sim, rooms, networking, renderer, input, HUD base
docs/     research.md: findings from the original Warlock 1.02 map (rules, spells, economy)
          wc3-observations.md: measured behaviour from real WC3, via wc3-instrumentation/
          (engine: movement, casting, knockback, camera)
```

**Networking.** The simulation runs in WC3's 0.03 s steps (33.3 Hz) on the host, and snapshots go out every other step. Clients send only orders and interpolate between snapshots.

- **Peer-to-peer (default):** the host's browser runs the room in a Web Worker, and guests connect over WebRTC via [PeerJS](https://peerjs.com). The public PeerJS server only introduces players. To use your own, build with `VITE_PEER_HOST` and related variables.
- **Relay fallback:** guests who can't connect directly (mobile data, strict wifi) switch to the Teng Games WebSocket relay on Cloudflare after 5 seconds.
- **Dedicated:** `server.js` runs the same room code behind a WebSocket.

Snapshots are sent as small deltas, over a lossy WebRTC channel where possible, and your own warlock is predicted so it responds instantly. **[docs/multiplayer.md](docs/multiplayer.md)** explains the whole stack, every setting, and how to reuse it in a new game.

The engine is copied here and in [Hammerguy's Party](https://github.com/JTstacky/Hammerguy-s-Party). Port engine fixes across when they matter to both games.

## Credits

Inspired by *Warlock* by Zymoran and Adynathos. The rules and numbers are based on the original map and on the authors' [Warlock Brawl](https://github.com/warlockbrawl/warlock). Warcraft is a trademark of Blizzard Entertainment. This fan-made game contains no Blizzard assets.
