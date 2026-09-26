"""kbfit.py N [tag] : knockback per trial from CL log (X,kb,ne,d / X,fb,ne markers), victim = W1."""
import sys, math
import clog


def run(n, vtag="W1"):
    recs = clog.read(n)
    trials, cur = [], None
    for g, t, f in recs:
        if g == "X" and f and f[0] in ("kb", "fb"):
            cur = dict(kind=f[0], ne=float(f[1]), d=float(f[2]) if len(f) > 2 else None, t0=t, D=[], W=[], H=[])
            trials.append(cur)
        elif cur is None:
            continue
        elif g == "D":
            cur["D"].append((t, f))
        elif g == vtag:
            cur["W"].append((t, float(f[0]), float(f[1]), float(f[4]), float(f[5]), int(f[6])))
        elif g == "H" + vtag[1:]:
            cur["H"].append((t, float(f[0]), float(f[1])))
    for tr in trials:
        D = tr["D"]
        if not D:
            print(tr["kind"], tr["ne"], tr["d"], "no damage event")
            continue
        td, f = D[0]
        dmg, mana_at = float(f[3]), float(f[8])
        W = [w for w in tr["W"] if w[0] >= td - 1e-6]
        if not W:
            continue
        # speed samples (script per-0.03 s speed), first nonzero
        sp = [(w[0], math.hypot(w[3], w[4])) for w in W if (w[3] or w[4])]
        v0 = sp[0][1] if sp else 0
        # decay ratio between successive distinct speeds
        vals = []
        for a in sp:
            if not vals or abs(a[1] - vals[-1][1]) > 1e-6:
                vals.append(a)
        ratios = [b[1] / a[1] for a, b in zip(vals, vals[1:6]) if a[1] > 0]
        x0, y0 = W[0][1], W[0][2]
        end = W[-1]
        dist = math.hypot(end[1] - x0, end[2] - y0)
        # time to (nearly) stop
        tstop = None
        for w in W:
            if math.hypot(w[3], w[4]) < 0.01 and w[0] > td + 0.05:
                tstop = w[0] - td
                break
        hp = [h for h in tr["H"] if h[0] >= td - 1e-6][:2]
        print("%s ne=%5.1f d=%5.1f | D at %.4f dmg=%.3f mana_at=%.2f | v0=%.3f u/step ratios=%s | slide=%.1f u, stop after %s s | hp/mana after %s | v0/(d*(100+mana))=%.6f" % (
            tr["kind"], tr["ne"], tr["d"] or -1, td, dmg, mana_at, v0, [round(r, 4) for r in ratios],
            dist, None if tstop is None else round(tstop, 3), hp, v0 / (dmg * (100 + mana_at)) if dmg else 0))


if __name__ == "__main__":
    run(int(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "W1")
