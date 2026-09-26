"""turns.py N : per-trial turn/move analysis of a CL log (kind 0/1/2 sweeps, exp4/exp5 sweeps)."""
import sys, math
import clog


def wrap(a):
    return (a + 180) % 360 - 180


def samples(recs, tag="W0"):
    out = []
    for g, t, f in recs:
        if g == tag and len(f) >= 7:
            out.append(dict(t=t, x=float(f[0]), y=float(f[1]), f=float(f[2]), o=int(f[3]), n=int(f[6])))
    return out


def split(recs):
    """-> list of dict(meta, t0, events, W) per X marker."""
    res, cur = [], None
    for g, t, f in recs:
        if g == "X":
            cur = dict(meta=f, t0=t, ev=[], W=[])
            res.append(cur)
        elif g == "M" and f and f[0].startswith("done"):
            cur = None
        elif cur is not None:
            if g == "W0" and len(f) >= 7:
                cur["W"].append(dict(t=t, x=float(f[0]), y=float(f[1]), f=float(f[2]), o=int(f[3]), n=int(f[6])))
            elif g in ("EP", "ET", "EI", "SCH", "SCA", "SEF", "SFI", "SEN", "D"):
                cur["ev"].append((g, t, f))
    return res


def analyse(tr, verbose=False):
    meta = tr["meta"]
    kind, ang = int(meta[1]), float(meta[2])
    ts, pw = float(meta[3]), float(meta[4])
    W = tr["W"]
    # the scripted order = last EP/ET before the trial's motion (kind 1 = ET 'blizzard')
    orders = [e for e in tr["ev"] if e[0] in ("EP", "ET")]
    if not orders:
        return None
    # the trial order: target ~500 u from the unit at angle ang (other EPs are the stand-up / next set-up)
    o = None
    for e in orders:
        f = e[2]
        tx, ty, ux, uy = float(f[2]), float(f[3]), float(f[5]), float(f[6])
        d = math.hypot(tx - ux, ty - uy)
        a = math.degrees(math.atan2(ty - uy, tx - ux))
        if abs(d - 500) < 20 and abs(wrap(a - ang)) < 2:
            o = e
            break
    if o is None:
        return None
    t_o = o[1]
    f = o[2]
    tx, ty, face0 = float(f[2]), float(f[3]), float(f[4])
    after = [s for s in W if s["t"] >= t_o - 1e-6]
    if not after:
        return None
    n0 = after[0]["n"]
    # facing updates and first movement
    fu = []  # (tick offset, facing)
    prev = None
    move_n = None
    x0, y0 = after[0]["x"], after[0]["y"]
    lastf = face0
    for s in after:
        if s["f"] != lastf:
            fu.append((s["n"] - n0, s["f"], wrap(s["f"] - lastf)))
            lastf = s["f"]
        if move_n is None and math.hypot(s["x"] - x0, s["y"] - y0) > 0.5:
            move_n = s["n"] - n0
            move_face = s["f"]
    tgt = math.degrees(math.atan2(ty - after[0]["y"], tx - after[0]["x"]))
    turn = wrap(tgt - face0)
    face_done = None
    for k, fa, d in fu:
        if abs(wrap(fa - tgt)) < 1.0:
            face_done = k
            break
    res = dict(kind=kind, ang=ang, ts=ts, pw=pw, turn=turn, move_tick=move_n,
               move_face_err=(wrap(move_face - tgt) if move_n is not None else None),
               face_done_tick=face_done, steps=[round(d, 2) for _, _, d in fu[:12]],
               step_ticks=[k for k, _, _ in fu[:12]])
    if verbose:
        print(res)
    return res


if __name__ == "__main__":
    recs = clog.read(int(sys.argv[1]))
    for tr in split(recs):
        r = analyse(tr)
        if r:
            print("k%d a%6.1f ts%.2f pw%.3f turn%7.1f move@%s err%s done@%s steps%s ticks%s" % (
                r["kind"], r["ang"], r["ts"], r["pw"], r["turn"], r["move_tick"],
                None if r["move_face_err"] is None else round(r["move_face_err"], 1),
                r["face_done_tick"], r["steps"][:8], r["step_ticks"][:8]))
