// A small byte-level zip parser for assertions on header fields that
// check.py does not report (extra-field order, raw DOS/UT values, which
// ZIP64 fields are present) or that a test wants to see directly (descriptor
// width). Independent of zip.ts.

import { open } from "node:fs/promises";

export interface Extra {
  id: number;
  data: Uint8Array;
}

export interface LocalEntry {
  offset: number;
  name: string;
  versionNeeded: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize32: number;
  size32: number;
  extras: Extra[];
  dataOffset: number;
  /** The descriptor between the data and the next record (its width is that gap), or null. */
  descriptor: { width: 16 | 24; crc: number; compressedSize: number; size: number } | null;
}

export interface CentralEntry {
  name: string;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize32: number;
  size32: number;
  externalAttributes: number;
  offset32: number;
  extras: Extra[];
  /** Values after resolving the ZIP64 extra. */
  compressedSize: number;
  size: number;
  offset: number;
}

export interface EndInfo {
  zip64End: boolean;
  count: number;
  centralOffset: number;
  centralSize: number;
}

export interface ParsedZip extends EndInfo {
  local: LocalEntry[];
  central: CentralEntry[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(v: DataView, p: number): number {
  return v.getUint32(p, true) + v.getUint32(p + 4, true) * 0x100000000;
}

function extrasOf(bytes: Uint8Array): Extra[] {
  const out: Extra[] = [];
  const v = view(bytes);
  for (let p = 0; p + 4 <= bytes.length; ) {
    const id = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    out.push({ id, data: bytes.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
}

/** EOCD fields (resolved through the ZIP64 end record when present) from the archive's tail (at least 98 bytes, or all of it). */
export function parseEnd(tail: Uint8Array): EndInfo {
  const v = view(tail);
  const eocd = tail.length - 22;
  if (v.getUint32(eocd, true) !== 0x06054b50) throw new Error("EOCD not at end - 22");
  const zip64End = eocd >= 76 && v.getUint32(eocd - 20, true) === 0x07064b50;
  if (zip64End) {
    const at = eocd - 20 - 56;
    if (v.getUint32(at, true) !== 0x06064b50)
      throw new Error("ZIP64 end record not before locator");
    return {
      zip64End,
      count: u64(v, at + 32),
      centralSize: u64(v, at + 40),
      centralOffset: u64(v, at + 48),
    };
  }
  return {
    zip64End,
    count: v.getUint16(eocd + 10, true),
    centralSize: v.getUint32(eocd + 12, true),
    centralOffset: v.getUint32(eocd + 16, true),
  };
}

/** Parse `count` central-directory records from `bytes`, which starts at the first one. */
export function parseCentralDirectory(bytes: Uint8Array, count: number): CentralEntry[] {
  const v = view(bytes);
  const central: CentralEntry[] = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`central signature at +${p}`);
    const nameLength = v.getUint16(p + 28, true);
    const extraLength = v.getUint16(p + 30, true);
    const commentLength = v.getUint16(p + 32, true);
    const extras = extrasOf(bytes.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));
    const e: CentralEntry = {
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      versionMadeBy: v.getUint16(p + 4, true),
      versionNeeded: v.getUint16(p + 6, true),
      flags: v.getUint16(p + 8, true),
      method: v.getUint16(p + 10, true),
      dosTime: v.getUint16(p + 12, true),
      dosDate: v.getUint16(p + 14, true),
      crc: v.getUint32(p + 16, true),
      compressedSize32: v.getUint32(p + 20, true),
      size32: v.getUint32(p + 24, true),
      externalAttributes: v.getUint32(p + 38, true),
      offset32: v.getUint32(p + 42, true),
      extras,
      compressedSize: 0,
      size: 0,
      offset: 0,
    };
    const z = extras.find((x) => x.id === 1)?.data;
    const zv = z ? view(z) : undefined;
    let zp = 0;
    const take = () => {
      if (!zv || zp + 8 > zv.byteLength) throw new Error(`${e.name}: ZIP64 extra too short`);
      const value = u64(zv, zp);
      zp += 8;
      return value;
    };
    e.size = e.size32 === 0xffffffff ? take() : e.size32;
    e.compressedSize = e.compressedSize32 === 0xffffffff ? take() : e.compressedSize32;
    e.offset = e.offset32 === 0xffffffff ? take() : e.offset32;
    if (z && zp !== z.length) throw new Error(`${e.name}: ZIP64 extra has unused fields`);
    central.push(e);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return central;
}

/** Parse a whole archive held in memory. */
export function parseZip(bytes: Uint8Array): ParsedZip {
  const v = view(bytes);
  const end = parseEnd(bytes);
  const central = parseCentralDirectory(bytes.subarray(end.centralOffset), end.count);
  const local: LocalEntry[] = central.map((c, i) => {
    const p = c.offset;
    if (v.getUint32(p, true) !== 0x04034b50) throw new Error(`${c.name}: local signature`);
    const nameLength = v.getUint16(p + 26, true);
    const extraLength = v.getUint16(p + 28, true);
    const dataOffset = p + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + c.compressedSize;
    // The descriptor fills the gap up to the next record exactly.
    const next = i + 1 < central.length ? central[i + 1]!.offset : end.centralOffset;
    const width = next - dataEnd;
    let descriptor: LocalEntry["descriptor"] = null;
    if ((width === 16 || width === 24) && v.getUint32(dataEnd, true) === 0x08074b50) {
      descriptor =
        width === 16
          ? {
              width,
              crc: v.getUint32(dataEnd + 4, true),
              compressedSize: v.getUint32(dataEnd + 8, true),
              size: v.getUint32(dataEnd + 12, true),
            }
          : {
              width,
              crc: v.getUint32(dataEnd + 4, true),
              compressedSize: u64(v, dataEnd + 8),
              size: u64(v, dataEnd + 16),
            };
    } else if (width !== 0) {
      throw new Error(`${c.name}: ${width} bytes between the data and the next record`);
    }
    return {
      offset: p,
      name: decoder.decode(bytes.subarray(p + 30, p + 30 + nameLength)),
      versionNeeded: v.getUint16(p + 4, true),
      flags: v.getUint16(p + 6, true),
      method: v.getUint16(p + 8, true),
      dosTime: v.getUint16(p + 10, true),
      dosDate: v.getUint16(p + 12, true),
      crc: v.getUint32(p + 14, true),
      compressedSize32: v.getUint32(p + 18, true),
      size32: v.getUint32(p + 22, true),
      extras: extrasOf(bytes.subarray(p + 30 + nameLength, dataOffset)),
      dataOffset,
      descriptor,
    };
  });
  return { ...end, local, central };
}

/** The end records and central directory of a zip file on disk (for archives too big to hold). */
export async function readCentralFromFile(
  path: string,
): Promise<EndInfo & { central: CentralEntry[]; size: number }> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 98);
    const tail = new Uint8Array(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const end = parseEnd(tail);
    const cd = new Uint8Array(end.centralSize);
    await file.read(cd, 0, cd.length, end.centralOffset);
    return { ...end, central: parseCentralDirectory(cd, end.count), size };
  } finally {
    await file.close();
  }
}

/** The local header of one entry, read from a zip file on disk. */
export async function readLocalFromFile(
  path: string,
  offset: number,
): Promise<{ versionNeeded: number; size32: number; compressedSize32: number; extras: Extra[] }> {
  const file = await open(path, "r");
  try {
    const head = new Uint8Array(30);
    await file.read(head, 0, 30, offset);
    const v = view(head);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error(`no local header at ${offset}`);
    const nameLength = v.getUint16(26, true);
    const extraLength = v.getUint16(28, true);
    const extra = new Uint8Array(extraLength);
    await file.read(extra, 0, extraLength, offset + 30 + nameLength);
    return {
      versionNeeded: v.getUint16(4, true),
      compressedSize32: v.getUint32(18, true),
      size32: v.getUint32(22, true),
      extras: extrasOf(extra),
    };
  } finally {
    await file.close();
  }
}

/** DOS date/time fields as [year, month, day, hour, minute, second]. */
export function dosParts(time: number, date: number): number[] {
  return [
    (date >> 9) + 1980,
    (date >> 5) & 15,
    date & 31,
    time >> 11,
    (time >> 5) & 63,
    (time & 31) * 2,
  ];
}

/** The UT extra's mtime (seconds), or undefined. */
export function utSeconds(extras: Extra[]): number | undefined {
  const ut = extras.find((x) => x.id === 0x5455)?.data;
  if (!ut || ut.length !== 5 || ut[0] !== 1) return undefined;
  return view(ut).getUint32(1, true);
}
