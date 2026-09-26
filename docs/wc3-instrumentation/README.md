# Warcraft III engine logger (Warlock 0.99)

These tools produced the engine-log results in [`../wc3-observations.md`](../wc3-observations.md). They
add a logger to a copy of the Warlock 0.99 map and parse its output. The map itself is not included:
`build.py` reads it from the local Warcraft III install.

| File | What it does |
|---|---|
| `cl_globals.j`, `cl_funcs.j` | JASS spliced into `war3map.j`. It adds a 0.01 s sampler, order/spell/damage event logging, chat commands (`-cl ...`) and scripted experiments. The log goes to `Logs\claude_N.txt` via `PreloadGenEnd`. |
| `build.py` | Reads `Maps\Download\Warlock 099.w3x` and splices in the logger (`CL_Init` runs after the map's init triggers). It renames the map to "Warlock 099 CL" and writes `Warlock099_CL.w3x` here. |
| `hdr.py` | Sets the name in the 512-byte HM3W header, which is what the map list shows. `build.py` calls it. |
| `mpq.py` | A minimal MPQ reader/writer for WC3 maps and archives. |
| `clog.py` | Parses `claude_N.txt` into `(tag, time, fields)` records. |
| `turns.py`, `model.py` | Per-trial turn analysis, checked against the step model of section 9. |
| `kbfit.py` | Knockback per trial: first step, decay and damage-taken level. |

## Using it

1. Run `python build.py`, then copy `Warlock099_CL.w3x` into `Warcraft III\Maps\Download`.
2. Start a single-player custom game on "Warlock 099 CL" with Player 2 set to a computer.
3. As red, type `-12` and wait for round 1.
4. Type `-cl exp1` … `-cl exp8`. Each experiment writes the next `Logs\claude_N.txt` when it finishes.
   `-cl dump` writes the log at any time.
5. Run `python model.py N` or `python kbfit.py N` (`clog.LOGS` points at the Warcraft III folder).

## Log records

Records are `;`-separated inside `Preload("...")` lines. The time `t` is game time in seconds with
0.0001 s resolution.

| Record | Fields |
|---|---|
| `W<p>,t,x,y,facing,order,kbVx,kbVy,tick` | Player p's warlock, logged when anything changes. `tick` counts the 0.01 s samples. |
| `H<p>,t,hp,mana` | HP and mana (damage taken) on change |
| `O<handle>,t,x,y` | Script projectiles, every 0.03 s |
| `EP/ET/EI,t,p,orderId,x,y,facing,ux,uy` | Point, target and immediate orders |
| `SCH/SCA/SEF/SFI/SEN,t,p,abil,facing,x,y` | Spell channel / cast / effect / finish / end-cast |
| `D,t,victim,source,srcType,dmg,sx,sy,vx,vy,mana` | Damage events on warlocks |
| `C,...` / `C2,...` | Camera fields, and camera target/eye positions |
| `X,t,...` | Experiment trial markers |
