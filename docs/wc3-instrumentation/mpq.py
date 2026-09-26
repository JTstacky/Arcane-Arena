"""Minimal MPQ (v0/v1) reader and writer for Warcraft III archives and maps.

Reader
    arc = MPQArchive(path_or_bytes)
    arc.read_file(r"war3map.j")        -> bytes or None
    arc.has_file(name)
    arc.names()                        -> names from (listfile) (+ any added with add_known_names)
    arc.hash_entries / arc.block_entries (raw tables)

  Supports: header search at 512-byte boundaries (HM3W map header in front),
  encrypted hash/block tables, file encryption (key from file basename, with
  and without FIX_KEY), single-unit files, sector CRC flag, compression masks
  zlib(0x02) / PKWare implode(0x08, and the 0x100 IMPLODE flag) / bzip2(0x10).
  Huffman/ADPCM (wave files only) are not supported.

Writer
    write_mpq(out_path, {name: bytes, ...}, map_header=bytes512 or None,
              compress=True, sector_shift=3)

  Writes an MPQ v0 archive: files stored zlib-compressed per sector (or raw
  when compression does not help / compress=False), unencrypted, with a
  (listfile), encrypted hash and block tables.  If map_header is given (the
  512-byte HM3W header of a source .w3x) it is written first and the MPQ
  starts at offset 512, exactly like a map saved by the World Editor.

Also: explode() -- a port of Mark Adler's blast.c (PKWare DCL decompressor).
"""
import bz2
import os
import struct
import zlib

# ----------------------------------------------------------------- crypto

def _build_crypt_table():
    table = [0] * 0x500
    seed = 0x00100001
    for i1 in range(0x100):
        i2 = i1
        for _ in range(5):
            seed = (seed * 125 + 3) % 0x2AAAAB
            t1 = (seed & 0xFFFF) << 16
            seed = (seed * 125 + 3) % 0x2AAAAB
            t2 = seed & 0xFFFF
            table[i2] = t1 | t2
            i2 += 0x100
    return table

CRYPT_TABLE = _build_crypt_table()

HASH_TABLE_OFFSET, HASH_NAME_A, HASH_NAME_B, HASH_FILE_KEY = 0, 1, 2, 3


def hash_string(s, htype):
    seed1, seed2 = 0x7FED7FED, 0xEEEEEEEE
    if isinstance(s, str):
        s = s.encode('latin-1')
    for ch in bytes(s):
        # Storm upper-cases ASCII and converts '/' to '\\'
        if 0x61 <= ch <= 0x7A:
            ch -= 0x20
        if ch == 0x2F:
            ch = 0x5C
        seed1 = CRYPT_TABLE[(htype << 8) + ch] ^ ((seed1 + seed2) & 0xFFFFFFFF)
        seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return seed1


def decrypt(data, key):
    n = len(data) // 4
    if n == 0:
        return bytes(data)
    vals = struct.unpack_from('<%dI' % n, data)
    out = []
    seed1, seed2 = key & 0xFFFFFFFF, 0xEEEEEEEE
    T = CRYPT_TABLE
    for v in vals:
        seed2 = (seed2 + T[0x400 + (seed1 & 0xFF)]) & 0xFFFFFFFF
        r = v ^ ((seed1 + seed2) & 0xFFFFFFFF)
        out.append(r)
        seed1 = ((((~seed1) << 0x15) + 0x11111111) & 0xFFFFFFFF) | (seed1 >> 0x0B)
        seed2 = (r + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return struct.pack('<%dI' % n, *out) + bytes(data[n * 4:])


def encrypt(data, key):
    n = len(data) // 4
    if n == 0:
        return bytes(data)
    vals = struct.unpack_from('<%dI' % n, data)
    out = []
    seed1, seed2 = key & 0xFFFFFFFF, 0xEEEEEEEE
    T = CRYPT_TABLE
    for v in vals:
        seed2 = (seed2 + T[0x400 + (seed1 & 0xFF)]) & 0xFFFFFFFF
        out.append(v ^ ((seed1 + seed2) & 0xFFFFFFFF))
        seed1 = ((((~seed1) << 0x15) + 0x11111111) & 0xFFFFFFFF) | (seed1 >> 0x0B)
        seed2 = (v + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return struct.pack('<%dI' % n, *out) + bytes(data[n * 4:])


# --------------------------------------------------- PKWare DCL "explode"
# Port of blast.c (c) Mark Adler, zlib license.
_MAXBITS = 13


class _Huff:
    __slots__ = ('count', 'symbol', 'table')

    def __init__(self, rep):
        length = []
        for b in rep:
            ln = b & 15
            length.extend([ln] * ((b >> 4) + 1))
        n = len(length)
        self.count = [0] * (_MAXBITS + 1)
        for ln in length:
            self.count[ln] += 1
        offs = [0] * (_MAXBITS + 2)
        for ln in range(1, _MAXBITS):
            offs[ln + 1] = offs[ln] + self.count[ln]
        self.symbol = [0] * n
        for sym in range(n):
            if length[sym]:
                self.symbol[offs[length[sym]]] = sym
                offs[length[sym]] += 1


_LITLEN = bytes([
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
    44, 173])
_LENLEN = bytes([2, 35, 36, 53, 38, 23])
_DISTLEN = bytes([2, 20, 53, 230, 247, 151, 248])
_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264]
_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]
_LITCODE = _Huff(_LITLEN)
_LENCODE = _Huff(_LENLEN)
_DISTCODE = _Huff(_DISTLEN)


def explode(data):
    """Decompress a PKWare DCL imploded buffer (as used by MPQ 0x08 / 0x100)."""
    src = data
    pos = [0]
    st = {'bitbuf': 0, 'bitcnt': 0}
    nsrc = len(src)

    def bits(need):
        val = st['bitbuf']
        cnt = st['bitcnt']
        while cnt < need:
            if pos[0] >= nsrc:
                raise ValueError('explode: out of input')
            val |= src[pos[0]] << cnt
            pos[0] += 1
            cnt += 8
        st['bitbuf'] = val >> need
        st['bitcnt'] = cnt - need
        return val & ((1 << need) - 1)

    def decode(h):
        bitbuf = st['bitbuf']
        left = st['bitcnt']
        code = first = index = 0
        ln = 1
        nxt = 1
        count = h.count
        while True:
            while left:
                left -= 1
                code |= (bitbuf & 1) ^ 1
                bitbuf >>= 1
                c = count[nxt]
                nxt += 1
                if code < first + c:
                    st['bitbuf'] = bitbuf
                    st['bitcnt'] = (st['bitcnt'] - ln) & 7
                    return h.symbol[index + (code - first)]
                index += c
                first += c
                first <<= 1
                code <<= 1
                ln += 1
            left = (_MAXBITS + 1) - ln
            if left == 0:
                break
            if pos[0] >= nsrc:
                raise ValueError('explode: out of input')
            bitbuf = src[pos[0]]
            pos[0] += 1
            if left > 8:
                left = 8
        raise ValueError('explode: bad code')

    lit = bits(8)
    if lit > 1:
        raise ValueError('explode: bad literal flag')
    dct = bits(8)
    if dct < 4 or dct > 6:
        raise ValueError('explode: bad dictionary size')
    out = bytearray()
    while True:
        if bits(1):
            sym = decode(_LENCODE)
            ln = _BASE[sym] + bits(_EXTRA[sym])
            if ln == 519:
                break
            sym = 2 if ln == 2 else dct
            dist = (decode(_DISTCODE) << sym) + bits(sym) + 1
            if dist > len(out):
                raise ValueError('explode: distance too far')
            start = len(out) - dist
            for i in range(ln):
                out.append(out[start + i])
        else:
            out.append(decode(_LITCODE) if lit else bits(8))
    return bytes(out)


# ------------------------------------------------------------ decompress

def decompress_sector(data, expected_size):
    if len(data) == 0:
        return b''
    mask = data[0]
    buf = data[1:]
    known = 0x02 | 0x08 | 0x10
    if mask & ~known:
        raise NotImplementedError('compression mask 0x%02x' % mask)
    if mask & 0x10:
        buf = bz2.decompress(buf)
    if mask & 0x08:
        buf = explode(buf)
    if mask & 0x02:
        buf = zlib.decompress(buf)
    return buf


# ------------------------------------------------------------------ flags
F_IMPLODE = 0x00000100
F_COMPRESS = 0x00000200
F_ENCRYPTED = 0x00010000
F_FIX_KEY = 0x00020000
F_SINGLE_UNIT = 0x01000000
F_DELETE_MARKER = 0x02000000
F_SECTOR_CRC = 0x04000000
F_EXISTS = 0x80000000

STANDARD_NAMES = [
    '(listfile)', '(attributes)', '(signature)',
    'war3map.j', 'scripts\\war3map.j', 'war3map.lua', 'war3map.w3e', 'war3map.w3i',
    'war3map.wtg', 'war3map.wct', 'war3map.wts', 'war3map.w3r', 'war3map.w3c',
    'war3map.w3s', 'war3map.w3u', 'war3map.w3t', 'war3map.w3a', 'war3map.w3b',
    'war3map.w3d', 'war3map.w3q', 'war3map.w3o', 'war3map.shd', 'war3map.mmp',
    'war3map.wpm', 'war3map.doo', 'war3mapUnits.doo', 'war3map.imp',
    'war3mapMisc.txt', 'war3mapSkin.txt', 'war3mapExtra.txt',
    'war3mapMap.blp', 'war3mapMap.tga', 'war3mapPreview.tga', 'war3mapPreview.blp',
    'war3mapPath.tga', 'war3map.blp', 'war3campaign.w3u', 'conversation.json',
    'Units\\UnitBalance.slk', 'Units\\UnitData.slk', 'Units\\UnitAbilities.slk',
    'Units\\UnitUI.slk', 'Units\\AbilityData.slk', 'Units\\MiscGame.txt',
    'Units\\MiscData.txt', 'Units\\UnitMetaData.slk', 'Units\\AbilityMetaData.slk',
    'Units\\UnitWeapons.slk', 'Units\\ItemData.slk', 'Units\\CommonAbilityStrings.txt',
    'Scripts\\common.j', 'Scripts\\Blizzard.j', 'Scripts\\common.ai',
    'UI\\MiscUI.txt', 'UI\\war3skins.txt', 'UI\\MiscData.txt', 'UI\\WorldEditData.txt',
    'UI\\TriggerData.txt', 'UI\\WorldEditStrings.txt', 'UI\\FrameDef\\GlobalStrings.fdf',
]


class MPQArchive:
    def __init__(self, src, header_offset=None):
        if isinstance(src, (bytes, bytearray)):
            self.data = bytes(src)
            self.path = None
        else:
            with open(src, 'rb') as f:
                self.data = f.read()
            self.path = src
        self.base = self._find_header() if header_offset is None else header_offset
        d = self.data
        b = self.base
        (magic, self.header_size, self.archive_size, self.format_version,
         self.sector_shift, ht_off, bt_off, ht_n, bt_n) = struct.unpack_from('<4sIIHHIIII', d, b)
        if magic != b'MPQ\x1a':
            raise ValueError('not an MPQ at %d' % b)
        self.sector_size = 512 << self.sector_shift
        self.ht_off, self.bt_off, self.ht_n, self.bt_n = ht_off, bt_off, ht_n, bt_n
        # WC3 treats everything as v0: offsets are 32-bit relative to the header.
        self.hash_entries = self._read_table(ht_off, ht_n, hash_string('(hash table)', 3))
        self.block_entries = self._read_table(bt_off, bt_n, hash_string('(block table)', 3))
        self._names = {}
        lf = self.read_file('(listfile)')
        if lf:
            for line in lf.replace(b'\r', b'\n').replace(b';', b'\n').split(b'\n'):
                line = line.strip()
                if line:
                    self._names[line.decode('latin-1').lower()] = line.decode('latin-1')

    def _find_header(self):
        off = 0
        while off + 32 <= len(self.data):
            if self.data[off:off + 4] == b'MPQ\x1a':
                return off
            off += 512
        raise ValueError('no MPQ header found')

    def _read_table(self, off, n, key):
        start = self.base + off
        # tolerate truncated / oversized tables (protected maps)
        avail = max(0, (len(self.data) - start) // 16)
        n2 = min(n, avail)
        raw = decrypt(self.data[start:start + n2 * 16], key)
        return [struct.unpack_from('<4I', raw, i * 16) for i in range(n2)]

    # -- lookup
    def find_block(self, name):
        if not self.hash_entries:
            return None
        n = len(self.hash_entries)
        # hash table size must be a power of two for the mask; use the header count
        mask = self.ht_n - 1
        start = hash_string(name, HASH_TABLE_OFFSET) & mask
        ha = hash_string(name, HASH_NAME_A)
        hb = hash_string(name, HASH_NAME_B)
        i = start
        for _ in range(n):
            if i >= n:
                i = 0
            e = self.hash_entries[i]
            blk = e[3]
            if blk == 0xFFFFFFFF:
                return None
            if e[0] == ha and e[1] == hb and blk != 0xFFFFFFFE:
                if blk < len(self.block_entries):
                    return blk
            i = (i + 1) & mask
        return None

    def has_file(self, name):
        return self.find_block(name) is not None

    def names(self):
        return sorted(self._names.values(), key=str.lower)

    def add_known_names(self, names):
        for n in names:
            if self.has_file(n):
                self._names.setdefault(n.lower(), n)

    def file_info(self, name):
        blk = self.find_block(name)
        if blk is None:
            return None
        off, csize, fsize, flags = self.block_entries[blk]
        return {'block': blk, 'offset': off, 'csize': csize, 'fsize': fsize, 'flags': flags}

    def read_file(self, name, force_key=None):
        blk = self.find_block(name)
        if blk is None:
            return None
        return self.read_block(blk, name, force_key)

    def file_key(self, name, blk):
        off, csize, fsize, flags = self.block_entries[blk]
        base = name.replace('/', '\\').split('\\')[-1]
        key = hash_string(base, HASH_FILE_KEY)
        if flags & F_FIX_KEY:
            key = ((key + off) ^ fsize) & 0xFFFFFFFF
        return key

    def read_block(self, blk, name=None, force_key=None):
        off, csize, fsize, flags = self.block_entries[blk]
        if not flags & F_EXISTS:
            return None
        d = self.data
        start = self.base + off
        raw = d[start:start + csize]
        encrypted = bool(flags & F_ENCRYPTED)
        key = None
        if encrypted:
            if force_key is not None:
                key = force_key
            elif name is None:
                raise ValueError('encrypted file needs a name')
            else:
                key = self.file_key(name, blk)
        if flags & F_SINGLE_UNIT:
            if encrypted:
                raw = decrypt(raw, key)
            if (flags & (F_COMPRESS | F_IMPLODE)) and csize < fsize:
                if flags & F_IMPLODE:
                    return explode(raw)[:fsize]
                return decompress_sector(raw, fsize)[:fsize]
            return raw[:fsize]
        ss = self.sector_size
        nsec = (fsize + ss - 1) // ss
        if flags & (F_COMPRESS | F_IMPLODE):
            ntab = nsec + 1 + (1 if flags & F_SECTOR_CRC else 0)
            tab = raw[:ntab * 4]
            if encrypted:
                tab = decrypt(tab, (key - 1) & 0xFFFFFFFF)
            offs = struct.unpack_from('<%dI' % ntab, tab)
            out = bytearray()
            for i in range(nsec):
                s = raw[offs[i]:offs[i + 1]]
                if encrypted:
                    s = decrypt(s, (key + i) & 0xFFFFFFFF)
                want = min(ss, fsize - i * ss)
                if len(s) < want:
                    if flags & F_IMPLODE:
                        s = explode(s)
                    else:
                        s = decompress_sector(s, want)
                out += s[:want]
            return bytes(out)
        # stored, maybe encrypted per sector
        out = bytearray()
        for i in range(nsec):
            s = raw[i * ss:(i + 1) * ss]
            if encrypted:
                s = decrypt(s, (key + i) & 0xFFFFFFFF)
            out += s
        return bytes(out[:fsize])


# ------------------------------------------------------------------ writer

def write_mpq(out_path, files, map_header=None, compress=True, sector_shift=3,
              add_listfile=True):
    """Write an MPQ v0 archive.

    files: dict name -> bytes (or list of (name, bytes)); names use backslashes.
    map_header: 512-byte HM3W block to prepend (MPQ then starts at offset 512).
    """
    items = list(files.items()) if isinstance(files, dict) else list(files)
    items = [(n.replace('/', '\\'), bytes(b)) for n, b in items if n.lower() != '(listfile)']
    if add_listfile:
        lf = '\r\n'.join(n for n, _ in items).encode('latin-1') + b'\r\n'
        items.append(('(listfile)', lf))
    ss = 512 << sector_shift
    nfiles = len(items)
    ht_n = 16
    while ht_n < nfiles * 2:
        ht_n <<= 1
    body = bytearray()
    HDR = 32
    blocks = []
    for name, data in items:
        off = HDR + len(body)
        fsize = len(data)
        flags = F_EXISTS
        if compress and fsize > 0:
            nsec = (fsize + ss - 1) // ss
            sectors = []
            for i in range(nsec):
                chunk = data[i * ss:(i + 1) * ss]
                c = zlib.compress(chunk, 9)
                if len(c) + 1 < len(chunk):
                    sectors.append(b'\x02' + c)
                else:
                    sectors.append(chunk)   # stored sector: size == expected
            tab_len = (nsec + 1) * 4
            offs = [tab_len]
            for s in sectors:
                offs.append(offs[-1] + len(s))
            # Like the World Editor: always COMPRESS + sector offset table, even
            # when a sector (or the whole file) is stored raw because zlib did
            # not help (a sector whose size == its full size is read as raw).
            blob = struct.pack('<%dI' % (nsec + 1), *offs) + b''.join(sectors)
            flags |= F_COMPRESS
        else:
            blob = data
        body += blob
        blocks.append((off, len(blob), fsize, flags))
    # tables
    ht = [(0xFFFFFFFF, 0xFFFFFFFF, 0xFFFF, 0xFFFF, 0xFFFFFFFF)] * ht_n
    ht = list(ht)
    for bi, (name, _) in enumerate(items):
        i = hash_string(name, HASH_TABLE_OFFSET) & (ht_n - 1)
        while ht[i][4] != 0xFFFFFFFF:
            i = (i + 1) & (ht_n - 1)
        ht[i] = (hash_string(name, HASH_NAME_A), hash_string(name, HASH_NAME_B), 0, 0, bi)
    ht_raw = b''.join(struct.pack('<IIHHI', *e) for e in ht)
    bt_raw = b''.join(struct.pack('<4I', *e) for e in blocks)
    ht_off = HDR + len(body)
    bt_off = ht_off + len(ht_raw)
    arc_size = bt_off + len(bt_raw)
    hdr = struct.pack('<4sIIHHIIII', b'MPQ\x1a', 32, arc_size, 0, sector_shift,
                      ht_off, bt_off, ht_n, len(blocks))
    out = bytearray()
    if map_header is not None:
        mh = bytes(map_header[:512]).ljust(512, b'\0')
        out += mh
    out += hdr + body
    out += encrypt(ht_raw, hash_string('(hash table)', 3))
    out += encrypt(bt_raw, hash_string('(block table)', 3))
    with open(out_path, 'wb') as f:
        f.write(out)
    return len(out)


def rebuild_map(src_path, out_path, replace=None, remove=(), compress=True):
    """Copy every file of a map (names from its (listfile) + STANDARD_NAMES) into
    a new archive, replacing/adding files from `replace` {name: bytes} and
    dropping names in `remove`.  The 512-byte HM3W header is copied.
    Returns the list of file names written."""
    src = MPQArchive(src_path)
    src.add_known_names(STANDARD_NAMES)
    files = {}
    for n in src.names():
        if n.lower() in ('(listfile)', '(attributes)', '(signature)'):
            continue
        b = src.read_file(n)
        if b is not None:
            files[n] = b
    low = {n.lower(): n for n in files}
    for n in remove:
        files.pop(low.get(n.lower(), n), None)
    for n, b in (replace or {}).items():
        files.pop(low.get(n.lower(), n), None)
        files[n] = bytes(b)
    header = src.data[:512] if src.base >= 512 else None
    write_mpq(out_path, files, map_header=header, compress=compress)
    return sorted(files)


def extract_all(arc, names):
    res = {}
    for n in names:
        b = arc.read_file(n)
        if b is not None:
            res[n] = b
    return res


if __name__ == '__main__':
    import sys
    a = MPQArchive(sys.argv[1])
    a.add_known_names(STANDARD_NAMES)
    for n in a.names():
        i = a.file_info(n)
        print('%-40s %8d %8d %08x' % (n, i['csize'], i['fsize'], i['flags']))
