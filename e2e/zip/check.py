"""Independent strict structural parser for yeet zips. Usage: check.py zip [manifest.json] [--tz-minutes N]

Written by the independent verifier of phase 0c (not by the author of zip.ts) and
copied here verbatim as the reference for the production test suite. It walks the
archive both ways (central directory and sequential local headers), checks flags,
versions, sizes, ZIP64 extras and their placement policy, UT extra, DOS time,
descriptor signature/width, contiguous offsets, and recomputes CRC/SHA-256.
Manifest: {path: {sha256, size, sizeKnown, mtime}} (directories: {mtime}).
Note: it holds each entry in memory while checking it (fine for the 4.5 GiB cases
on a 48 GiB machine).
"""
import json, os, struct, sys, zlib, hashlib, time, datetime, mmap

M32 = 0xFFFFFFFF
errs = []
def bad(msg):
    errs.append(msg)

def parse_extra(b):
    out = {}
    i = 0
    while i < len(b):
        if i + 4 > len(b): bad("truncated extra"); break
        hid, ln = struct.unpack_from("<HH", b, i)
        if hid in out: bad(f"duplicate extra 0x{hid:04x}")
        out[hid] = b[i+4:i+4+ln]
        i += 4 + ln
    if i != len(b): bad("extra length mismatch")
    return out

def dos_to_tuple(t, d):
    return ((d >> 9) + 1980, (d >> 5) & 15, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2)

def main():
    path = sys.argv[1]
    man = json.load(open(sys.argv[2])) if len(sys.argv) > 2 and sys.argv[2].endswith(".json") else None
    tz = None
    if "--tz-minutes" in sys.argv: tz = int(sys.argv[sys.argv.index("--tz-minutes")+1])
    f = open(path, "rb"); mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ); n = len(mm)
    # ---- EOCD
    eocd = mm.rfind(b"PK\x05\x06", max(0, n - 65557))
    if eocd != n - 22: bad(f"EOCD not at end-22 (at {eocd}, n={n})")
    _, dsk, dskcd, cnt_d, cnt, cdsize, cdoff, clen = struct.unpack_from("<IHHHHIIH", mm, eocd)
    if dsk or dskcd: bad("disk numbers nonzero")
    if cnt_d != cnt: bad("eocd counts differ")
    if clen: bad("comment")
    z64 = None
    if eocd >= 20 and mm[eocd-20:eocd-16] == b"PK\x06\x07":
        _, zd, z64off, tdisks = struct.unpack_from("<IIQI", mm, eocd-20)
        if zd != 0 or tdisks != 1: bad("locator disk fields")
        if mm[z64off:z64off+4] != b"PK\x06\x06": bad("zip64 eocd sig")
        if z64off + 56 != eocd - 20: bad("zip64 eocd not adjacent to locator")
        _, rsz, vmade, vneed, d1, d2, c1, c2, cds, cdo = struct.unpack_from("<IQHHIIQQQQ", mm, z64off)
        if rsz != 44: bad("zip64 eocd size field")
        if c1 != c2: bad("z64 counts")
        z64 = dict(count=c1, cdsize=cds, cdoff=cdo, off=z64off)
    count = z64["count"] if z64 else cnt
    cd_size = z64["cdsize"] if z64 else cdsize
    cd_off = z64["cdoff"] if z64 else cdoff
    if z64:
        # classic fields must be saturated only when overflowing
        if cnt != min(count, 0xFFFF): bad(f"eocd count {cnt} vs {count}")
        if cdsize != min(cd_size, M32): bad("eocd cdsize")
        if cdoff != min(cd_off, M32): bad("eocd cdoff")
        need = count >= 0xFFFF or cd_off >= M32 or cd_size >= M32
        if not need: bad("ZIP64 EOCD present but not needed")
        cd_end_expected = z64["off"]
    else:
        if count >= 0xFFFF or cd_off >= M32: bad("ZIP64 EOCD missing")
        cd_end_expected = eocd
    if cd_off + cd_size != cd_end_expected: bad(f"cd_off+cd_size {cd_off}+{cd_size} != {cd_end_expected}")
    # ---- central directory
    p = cd_off; cen = []
    for i in range(count):
        if mm[p:p+4] != b"PK\x01\x02": bad(f"central sig at {p}"); break
        (_, vmade, vneed, flags, meth, t, d, crc, csz, usz, nlen, elen, clen2, dstart, iattr, eattr, loff) = struct.unpack_from("<IHHHHHHIIIHHHHHII", mm, p)
        name = bytes(mm[p+46:p+46+nlen]); extra = parse_extra(bytes(mm[p+46+nlen:p+46+nlen+elen]))
        z = extra.get(1, b""); zi = 0
        def take():
            nonlocal zi
            if zi + 8 > len(z): bad(f"{name!r}: zip64 central extra too short"); return None
            v = struct.unpack_from("<Q", z, zi)[0]; zi += 8; return v
        real_u = take() if usz == M32 else usz
        real_c = take() if csz == M32 else csz
        real_o = take() if loff == M32 else loff
        if zi != len(z): bad(f"{name!r}: central zip64 extra has {len(z)} bytes, used {zi} (unneeded fields)")
        if usz == M32 and real_u is not None and real_u < M32 and real_c is not None and real_c < M32: bad(f"{name!r}: central zip64 sizes but neither overflows")
        if loff == M32 and real_o is not None and real_o < M32: bad(f"{name!r}: zip64 offset not needed")
        if clen2 or dstart: bad("comment/disk")
        if vmade >> 8 != 3: bad("made-by not unix")
        cen.append(dict(name=name, vneed=vneed, flags=flags, meth=meth, t=t, d=d, crc=crc, csz=real_c, usz=real_u, off=real_o, extra=extra, eattr=eattr))
        p += 46 + nlen + elen + clen2
    if p != cd_off + cd_size: bad(f"central dir walk ended at {p}, expected {cd_off+cd_size}")
    # ---- walk local headers sequentially (streaming-reader view)
    p = 0
    names = []
    for c in cen:
        nm = c["name"]
        if p != c["off"]: bad(f"{nm!r}: local header at {p}, central says {c['off']}")
        p = c["off"]
        if mm[p:p+4] != b"PK\x03\x04": bad(f"{nm!r}: local sig"); continue
        (_, vneed, flags, meth, t, d, crc, csz, usz, nlen, elen) = struct.unpack_from("<IHHHHHIIIHH", mm, p)
        lname = bytes(mm[p+30:p+30+nlen]); lextra = parse_extra(bytes(mm[p+30+nlen:p+30+nlen+elen]))
        if lname != nm: bad(f"local/central name differ {nm!r}")
        if flags != c["flags"] or meth != c["meth"] or t != c["t"] or d != c["d"]: bad(f"{nm!r}: local/central flags/method/time differ")
        if not flags & 0x800: bad(f"{nm!r}: UTF-8 flag missing")
        try: s = nm.decode("utf-8")
        except UnicodeDecodeError: bad(f"{nm!r}: not utf-8"); s = ""
        names.append(s)
        is_dir = s.endswith("/")
        if flags & ~0x0808: bad(f"{nm!r}: unexpected flags {flags:#x}")
        if is_dir:
            if flags & 8: bad(f"{nm!r}: dir has descriptor")
            if meth != 0 or c["csz"] or c["usz"] or c["crc"]: bad(f"{nm!r}: dir not empty/stored")
            if not c["eattr"] & 0x10: bad(f"{nm!r}: dir attr")
        else:
            if not flags & 8: bad(f"{nm!r}: no data descriptor flag")
        if crc != 0: bad(f"{nm!r}: local crc nonzero")
        z64l = 1 in lextra
        if z64l:
            if (csz, usz) != (M32, M32): bad(f"{nm!r}: zip64 local but 32-bit sizes {csz:#x},{usz:#x}")
            if len(lextra[1]) != 16: bad(f"{nm!r}: local zip64 extra len {len(lextra[1])}")
            if vneed < 45: bad(f"{nm!r}: zip64 local but version needed {vneed}")
        else:
            if (csz, usz) != (0, 0): bad(f"{nm!r}: local sizes nonzero")
            if vneed != 20: bad(f"{nm!r}: version needed {vneed}")
        if c["vneed"] != vneed:
            if not (c["vneed"] == 45 and vneed == 20 and c["off"] >= M32): bad(f"{nm!r}: central vneed {c['vneed']} != local {vneed}")
            else: print(f"   note: {nm!r} central vneed 45 (zip64 offset) vs local 20")
        if meth not in (0, 8): bad(f"{nm!r}: method {meth}")
        # UT extra
        ut = lextra.get(0x5455)
        if not ut or ut[0] != 1 or len(ut) != 5: bad(f"{nm!r}: UT extra local bad")
        cut = c["extra"].get(0x5455)
        if cut != ut: bad(f"{nm!r}: central UT differs")
        utime = struct.unpack_from("<I", ut, 1)[0] if ut else 0
        dp = p + 30 + nlen + elen
        # decompress and CRC independently
        data = mm[dp:dp + c["csz"]]
        if meth == 8:
            dec = zlib.decompressobj(-15); raw = dec.decompress(data) + dec.flush()
            if not dec.eof: bad(f"{nm!r}: deflate stream not terminated within csize")
            if dec.unused_data: bad(f"{nm!r}: deflate has trailing bytes inside csize")
        else:
            raw = data
        if len(raw) != c["usz"]: bad(f"{nm!r}: uncompressed len {len(raw)} != {c['usz']}")
        mycrc = zlib.crc32(raw) & M32
        if mycrc != c["crc"]: bad(f"{nm!r}: CRC mismatch computed {mycrc:#x} central {c['crc']:#x}")
        q = dp + c["csz"]
        if not is_dir:
            if mm[q:q+4] != b"PK\x07\x08": bad(f"{nm!r}: descriptor signature missing at {q}")
            if z64l:
                dcrc, dc, du = struct.unpack_from("<IQQ", mm, q+4); q += 24
            else:
                dcrc, dc, du = struct.unpack_from("<III", mm, q+4); q += 16
            if (dcrc, dc, du) != (c["crc"], c["csz"], c["usz"]): bad(f"{nm!r}: descriptor {(dcrc,dc,du)} != central {(c['crc'],c['csz'],c['usz'])}")
        # ZIP64 policy: local zip64 iff size unknown or >= 4GiB-16MiB
        if man is not None:
            e = man.get(s)
            if e is None: bad(f"unexpected entry {s!r}")
            else:
                if not is_dir:
                    if hashlib.sha256(raw).hexdigest() != e["sha256"]: bad(f"{s!r}: sha256 mismatch")
                    want_z64 = (not e["sizeKnown"]) or e["size"] >= M32 - 0x1000000
                    if want_z64 != z64l: bad(f"{s!r}: zip64 local {z64l}, expected {want_z64}")
                if utime != int(e["mtime"] // 1000): bad(f"{s!r}: UT {utime} != {int(e['mtime']//1000)}")
                secs = e["mtime"] / 1000
                lt = (datetime.datetime.fromtimestamp(secs, datetime.timezone.utc) + datetime.timedelta(minutes=tz)) if tz is not None else datetime.datetime.fromtimestamp(secs)
                want = (lt.year, lt.month, lt.day, lt.hour, lt.minute, lt.second - lt.second % 2)
                if dos_to_tuple(t, d) != want: bad(f"{s!r}: DOS {dos_to_tuple(t,d)} != local {want}")
        p = q
    if p != cd_off: bad(f"local walk ended at {p}, central dir at {cd_off}")
    if man is not None and sorted(names) != sorted(man): bad(f"name set differs: {sorted(set(names)^set(man))}")
    print(f"{os.path.basename(path)}: {len(cen)} entries, zip64eocd={'yes' if z64 else 'no'}, " + ("OK" if not errs else f"{len(errs)} ERRORS"))
    for e in errs[:15]: print("   -", e)
    sys.exit(1 if errs else 0)
main()
