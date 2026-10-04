# Research notes: the original Warlock map

These notes come from unpacking the original map files, taken from the GitLab archive
`TheBestPlan/warcraft3-maps`:

- `Warlock v1.02.w3x` by Zymoran and Adynathos
- `UtherParty.w3x` by TheZizz

They also use the WC3 1.30.4 unit data files and the Warlock Brawl (Dota 2 port) source.
The Warlock script is obfuscated, so the meaning of each variable was worked out from context.

## How Warlock movement works in the original

**Unit data.** The warlock unit (`h000`) is based on the Peasant. Its fields are:

- Movement speed **210**.
- **Turn rate 0.6** (radians per 0.03 s frame). The engine caps turning at about 0.2 rad per frame, roughly 382°/s.
- **Propulsion window 60°**.
- Orientation interpolation 0.
- **Cast point 0.3 s**, backswing 0.51 s.
- Collision size 0. Unit-to-unit collision is handled in the script instead.
- 100 HP.

**The 0.03 s script loop.**

1. The WC3 engine still performs normal ordered movement: the warlock turns at its turn rate and only walks once facing within the propulsion window.
2. On each tick, the script reads how far the engine moved the unit, `GetUnitX(M) - W`. It turns that into a walking step of fixed length (`mv = 210 × 0.03 = 6.3` units).
3. On **normal ground** it updates velocity like this:
   ```
   vv = (vv - av) * .96      // remove last tick's walk step, decay knockback 4% per tick
   av = mv * dir             // this tick's walk step (full speed, no acceleration)
   vv = vv + av
   ```
4. On **ice**, walking instead accelerates the unit, and all velocity decays by ×0.97 per tick. This gives real sliding momentum.
5. Stunned units decay by ×0.93 per tick.

**Knockback from a hit** is calculated in function `Wb`:
```
wb = (100 + NE[victim]) * dmg * dmgDealtMult * dmgTakenMult * 0.03 * kbTakenMult * factor
vv += wb * dir(from source to victim)
```
- `NE` is the damage the victim has taken this round.
- Every hit adds its damage to `NE`, and lava adds half its damage.
- `NE` is shown on the mana bar.
- The result is in units per tick, so the speed is `(100 + NE) × dmg` units per second.
- Example: a 7-damage Fireball on a fresh warlock gives 700 u/s, which carries it about 525 units.

**Other rules.**

- **Collisions.** Warlocks push each other apart in the script loop, which also checks for fast-moving collisions.
- **Lava.** Deals 9 HP/s, checked every 0.1 s. Off the lava you regenerate 0.5 HP/s.
- **Arena.** The starting radius is `9 + floor(sqrt(players))` tiles. It shrinks by one tile every `15 × sqrt(players alive)` seconds.
- **Economy.** You start with 20 gold and get 10 per round. Kills and round wins give no gold.
- **Rounds.** The shop lasts 30 s (40 s for the first shop). A game is 11 rounds.
- **Points.** A kill, an assist and a round win are worth 1 point each.

**Hotkeys.**

| Key | Spells |
|---|---|
| G | Fireball |
| D | Lightning, Homing, Boomerang |
| R | Teleport, Thrust, Swap |
| T | Drain, Bouncer, Fire Spray |
| E | Meteor, Wind Walk, Splitter |
| C | Shield, Rush, Time Shift, Mirror |
| Y | Link, Gravity, Disable, Control |

**Spell numbers** (100-HP scale):

| Spell | Buy cost | Damage | Cooldown | Other |
|---|---|---|---|---|
| Fireball | — | 7 (+0.5 per level) | 4.8 s | 1000 u/s, lifetime 1 s. **Our change (playtest feedback):** each level adds 60 range (990 → 1350) |
| Lightning | 11 | 7 → 11 | 16.5 → 13.5 s | |
| Homing | 11 | 7 → 12 | 15 → 11 s | lifetime 4.5 s |
| Boomerang | 11 | 7 → 10 | 16 → 10.3 s | |
| Teleport | 11 | — | 16 → 7 s | range 770 (+70 per level); cuts current knockback by 20%. **Our change (playtest):** 12 → 5 s, range 900 → 1400 |
| Thrust | 11 | 5.4 (+0.4 per level) | 16.5 → 9 s | |
| Swap | 11 | — | 15.8 → 8.8 s | |
| Drain | 14 | 6 (+1 per level) | 22 s (−1 per level) | slows the target by 50 speed for 4 s (+1 s per level) |
| Bouncer | 14 | 5.4 (+0.8 per level) | 20 → 15 s | −20% damage per bounce |
| Meteor | 14 | 4 to 11 (+1 per level) | 20 s (−0.5 per level) | area 225 → 294. **Our change (playtest feedback):** 6 to 16 at level 1, up to 13 to 25 |
| Wind Walk | 15 | 5.4 (+0.6 per level) | 30 → 19.5 s | 2.6 s, +200 speed |
| Shield | 12 | — | 25 → 17 s | lasts 2.8 → 3.8 s. **Our change (playtest; it is autocast here):** 32 → 24 s, lasts 1.4 → 1.9 s |
| Rush | 12 | — | 21 s (−1 per level) | absorbs 5 (+2 per level). **Our change (playtest):** 16 → 10 s, absorbs 9 → 24 |
| Link | 11 | 0.2 (+0.1 per level) | 17 → 7 s | |
| Gravity | 12 | 0.3 (+0.2 per level) | 21 → 19 s | force 13 (+1 per level) |
| Scourge | — | 10 around you, including yourself | 3 s | 1 s wind-up that cannot be stopped; no walking during it, knockback still applies (per Justin) |

## What to check in the real game (for playtesting)

1. From standing, right-click directly behind the warlock. Check whether it turns fully on the spot before walking, how long the about-face takes (about 0.33 s is expected), and whether it arcs.
2. Zig-zag with quick right-clicks. Check whether it ever speeds up or slows down. On normal ground it should not; on ice it should.
3. Cast behind yourself. Check that it turns during the 0.3 s cast point, and that a right-click during the cast point cancels the spell.
4. Take Fireball hits at 0, 50 and 100 damage taken. The slide should roughly double at 100.
5. Stand in lava and time how fast HP drops (about 9 HP/s is expected).
