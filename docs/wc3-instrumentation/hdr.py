"""hdr.py MAP : rename a built map in its 512-byte HM3W header (the name the map list shows) to "Warlock 099 CL"."""
import sys, struct
p = sys.argv[1]
b = bytearray(open(p, "rb").read())
assert b[:4] == b"HM3W"
end = b.index(b"\0", 8)
name = bytes(b[8:end]); rest = bytes(b[end+1:end+9])
flags, players = struct.unpack("<II", rest)
print("old", name, hex(flags), players)
new = b"HM3W\0\0\0\0" + b"Warlock 099 CL\0" + rest
b[:512] = new.ljust(512, b"\0")
open(p, "wb").write(b)
print("new", bytes(b[:40]))
