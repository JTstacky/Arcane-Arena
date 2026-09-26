"""clog.py : parse Logs\\claude_N.txt written by the CL logger into records."""
import re, glob, os

LOGS = r"E:\Games\Warcraft III\Logs"


def read(n=None):
    """Return list of (tag, t, fields[]) from claude_n.txt (all files if n is None, in order)."""
    files = [os.path.join(LOGS, "claude_%d.txt" % n)] if n is not None else sorted(
        glob.glob(os.path.join(LOGS, "claude_*.txt")), key=lambda p: int(re.findall(r"\d+", os.path.basename(p))[0]))
    out = []
    for p in files:
        txt = open(p, encoding="latin-1").read()
        for chunk in re.findall(r'call Preload\( "(.*)" \)', txt):
            for rec in chunk.split(";"):
                if not rec:
                    continue
                f = rec.split(",")
                try:
                    t = float(f[1])
                except (IndexError, ValueError):
                    t = None
                out.append((f[0], t, f[2:]))
    return out


def trials(recs, tag_prefix="W0"):
    """Split unit-0 samples by X (trial marker) records -> list of (marker_fields, t0, samples)."""
    res, cur = [], None
    for tag, t, f in recs:
        if tag == "X":
            cur = (f, t, [], [])
            res.append(cur)
        elif cur is not None and tag == tag_prefix:
            cur[2].append((t, float(f[0]), float(f[1]), float(f[2]), int(f[3])))
        elif cur is not None and tag in ("EP", "ET", "EI", "SCH", "SCA", "SEF", "SFI", "SEN", "D", "K", "M"):
            cur[3].append((tag, t, f))
    return res


if __name__ == "__main__":
    import sys
    r = read(int(sys.argv[1]) if len(sys.argv) > 1 else None)
    from collections import Counter
    print(Counter(x[0] for x in r))
    for x in r:
        if x[0] in ("B", "U", "C", "C2", "K", "M", "X"):
            print(x)
