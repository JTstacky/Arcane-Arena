"""build.py : splice the Claude logger into Warlock 099's war3map.j and write a new map."""
import os, sys, hashlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mpq

SRC = r"E:\Games\Warcraft III\Maps\Download\Warlock 099.w3x"
OUT = os.path.join(HERE, "Warlock099_CL.w3x")

arc = mpq.MPQArchive(SRC)
names = arc.names()
print("files:", len(names), [n for n in names if n.startswith("(")])
j = arc.read_file("war3map.j").decode("latin-1")
glob = open(os.path.join(HERE, "cl_globals.j")).read()
funcs = open(os.path.join(HERE, "cl_funcs.j")).read()

i = j.index("\nendglobals")
j = j[:i] + "\n" + glob.rstrip("\n") + j[i:]
i = j.index("function main takes nothing returns nothing")
j = j[:i] + funcs + "\n" + j[i:]
k = j.index("call RunInitializationTriggers(  )", i)
k = j.index("\n", k)
j = j[:k] + "\n    call CL_Init(  )" + j[k:]
assert j.count("call CL_Init(  )") == 1
open(os.path.join(HERE, "war3map_cl.j"), "w", encoding="latin-1", newline="").write(j)

# map name is TRIGSTR_001 -> "STRING 1 { Warlock 099 }" in war3map.wts
wts = arc.read_file("war3map.wts")
k = wts.index(b"STRING 1")
v = wts.index(b"Warlock 099", k)
assert v - k < 20
wts = wts[:v] + b"Warlock 099 CL" + wts[v + len(b"Warlock 099"):]

remove = [n for n in names if n.lower() in ("(attributes)",)]
mpq.rebuild_map(SRC, OUT, replace={"war3map.j": j.encode("latin-1"), "war3map.wts": wts}, remove=remove, compress=True)
import subprocess; subprocess.check_call([sys.executable, os.path.join(HERE, "hdr.py"), OUT])  # HM3W header name = map list name
back = mpq.MPQArchive(OUT)
assert back.read_file("war3map.j").decode("latin-1") == j
print("wrote", OUT, os.path.getsize(OUT), "bytes; removed", remove, "; sha", hashlib.sha256(open(OUT, "rb").read()).hexdigest()[:12])
