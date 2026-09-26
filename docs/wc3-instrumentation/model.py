"""model.py N [N...] : check the step model of WC3 turning against CL trial logs.

Model (per 0.03 s unit step k = 1, 2, ...), heading h_0 = facing at order:
    moving_k = |target - h_{k-1}| <= propwindow
    h_k      = h_{k-1} + clamp(target - h_{k-1}, +-turnrate rad)
    if moving_k: walk this step along h_k
Observed: facing-update ticks give the step grid; first tick with motion along a new direction and its direction.
"""
import sys, math
import clog, turns

wrap = turns.wrap


def observe(tr):
    meta = tr["meta"]
    kind, ang, ts, pw = int(meta[1]), float(meta[2]), float(meta[3]), float(meta[4])
    o = None
    for e in tr["ev"]:
        if e[0] not in ("EP", "ET"):
            continue
        f = e[2]
        tx, ty, ux, uy = float(f[2]), float(f[3]), float(f[5]), float(f[6])
        if abs(math.hypot(tx - ux, ty - uy) - 500) < 20 and abs(wrap(math.degrees(math.atan2(ty - uy, tx - ux)) - ang)) < 2:
            o = e
            break
    if o is None:
        return None
    t_o = o[1]
    f = o[2]
    tx, ty, face0 = float(f[2]), float(f[3]), float(f[4])
    W = [s for s in tr["W"] if s["t"] >= t_o - 1e-6]
    if len(W) < 5:
        return None
    # tick of the order: W samples carry (t, n); interpolate n at t_o
    n_o = W[0]["n"] - round((W[0]["t"] - t_o) / 0.01)
    tgt = math.degrees(math.atan2(ty - float(f[6]), tx - float(f[5])))
    # step grid from facing updates
    fticks = []
    lastf = face0
    for s in W:
        if s["f"] != lastf:
            fticks.append(s["n"])
            lastf = s["f"]
    # per-tick motion (fill gaps: no record = no change)
    segs = []
    for a, b in zip(W, W[1:]):
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        d = math.hypot(dx, dy)
        segs.append((b["n"], b["n"] - a["n"], d, math.degrees(math.atan2(dy, dx)) if d > 0.3 else None))
    # first tick moving in a direction within 25 deg of neither the old heading (kind 2) ... simply: first motion
    # after the order whose direction differs from face0 by > 1 deg, or any motion for standing starts
    first = None
    for n, dn, d, a in segs:
        if a is None:
            continue
        if kind == 2 and abs(wrap(a - face0)) < 1.0 and abs(wrap(tgt - face0)) > 1.0:
            continue  # still walking the old way
        first = (n, a, d / max(dn, 1))
        break
    return dict(kind=kind, ang=ang, ts=ts, pw=math.degrees(pw), tgt=tgt, face0=face0, n_o=n_o,
                fticks=fticks[:12], first=first, W=W)


def predict(face0, tgt, ts, pw_deg, maxk=40):
    h = face0
    for k in range(1, maxk):
        moving = abs(wrap(tgt - h)) <= pw_deg + 1e-6
        d = wrap(tgt - h)
        step = math.degrees(ts)
        h = h + max(-step, min(step, d))
        if moving:
            return k, h
    return None, h


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        recs = clog.read(int(arg)) if arg.isdigit() else None
        for tr in turns.split(recs):
            ob = observe(tr)
            if not ob or not ob["first"]:
                continue
            k_obs = None
            if ob["fticks"]:
                n1 = ob["fticks"][0]
                k_obs = (ob["first"][0] - n1) / 3.0 + 1
            k_pred, h_pred = predict(ob["face0"], ob["tgt"], ob["ts"], ob["pw"])
            print("k%d a%6.1f ts%.2f pw%5.1f | order->step1 %s ticks, first move tick-step1=%s => step %.2f dir %.1f (rel %.1f) | pred step %s dir %.1f" % (
                ob["kind"], ob["ang"], ob["ts"], ob["pw"],
                ob["fticks"][0] - ob["n_o"] if ob["fticks"] else None,
                ob["first"][0] - ob["fticks"][0] if ob["fticks"] else None,
                k_obs or -1, ob["first"][1], wrap(ob["first"][1] - ob["face0"]),
                k_pred, wrap(h_pred - ob["face0"])))
