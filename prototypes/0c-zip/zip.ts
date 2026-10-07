// Streaming ZIP writer built on Web Streams. Prototype (phase 0c).
//
// Isomorphic by construction: the only globals used are ReadableStream,
// TransformStream, TextEncoder, Uint8Array/DataView and (as an overridable
// default) CompressionStream. Anything runtime-specific (a faster deflate, a
// native CRC-32) is injected through options. No imports, no dependencies, so
// the file can be copied verbatim into packages that must be self-contained.
//
// Output layout per entry (sizes are unknown when the header is written, so
// general purpose bit 3 is always set for file entries):
//
//   local file header | file data | data descriptor
//
// followed by the central directory, an optional ZIP64 end of central
// directory record + locator, and the end of central directory record.

/** One file (or directory, when `path` ends in "/") to add to the archive. */
export interface ZipEntry {
  /** Relative path inside the archive, "/"-separated. A trailing "/" marks a directory. */
  path: string;
  /** Modification time in milliseconds since the epoch. Defaults to the time the entry is written. */
  lastModified?: number;
  /**
   * Uncompressed size in bytes, if known up front. When given and below the
   * ZIP64 threshold the entry is written without ZIP64 structures; the
   * stream must then yield exactly this many bytes or the archive errors.
   * When omitted the entry is written with ZIP64 local fields (safe for any size).
   */
  size?: number;
  /** Deflate this entry. Defaults to `options.compress`, then to the extension heuristic. */
  compress?: boolean;
  /** Entry contents. Not called for directories. */
  stream?: () => ReadableStream<Uint8Array>;
}

/** Anything with a writable and a readable side: CompressionStream, Duplex.toWeb(zlib.createDeflateRaw()), ... */
export interface ByteTransform {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
}

export interface ZipOptions {
  /**
   * Default compression for entries that do not set `compress`.
   * `true` (default): deflate, except for already-compressed extensions (see `isCompressedPath`).
   * `false`: store everything.
   */
  compress?: boolean;
  /** Factory for a raw-deflate transform. Defaults to `new CompressionStream("deflate-raw")`. */
  deflateRaw?: () => ByteTransform;
  /** CRC-32 update function with zlib's signature `(data, previous) => crc`. Defaults to a pure JS slice-by-8. */
  crc32?: (data: Uint8Array, previous: number) => number;
  /**
   * "auto" (default): ZIP64 structures only where needed (entries with an
   * unknown or large `size`, offsets or counts past the classic limits).
   * "always": ZIP64 for every entry and the end records. Testing only:
   * ditto rejects stored entries whose central header carries ZIP64 sizes
   * below 4 GiB.
   */
  zip64?: "auto" | "always";
  /**
   * Minutes east of UTC used for the DOS date/time fields, which have no
   * time zone and are shown as-is by readers that ignore the UTC timestamp
   * extra field (measured: ditto; reportedly Windows Explorer). Defaults to
   * the producer's local offset at each entry's mtime (always 0 in workerd).
   */
  timeZoneOffset?: number;
  /**
   * Prototype-only knobs for testing reader compatibility of ZIP64 variants.
   * `centralZip64`: "needed" puts a ZIP64 extra in a central header only for
   * fields that overflow; "mirror" also adds it (with both sizes) whenever
   * the local header used ZIP64.
   * `localSizes`: value of the 32-bit size fields in a ZIP64 local header.
   */
  experimental?: { centralZip64?: "needed" | "mirror"; localSizes?: "ffffffff" | "zero" };
}

/** Extensions whose contents are already compressed; deflating them wastes CPU for ~0% gain. */
export const COMPRESSED_EXTENSIONS: ReadonlySet<string> = new Set([
  // audio
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "flac",
  "wma",
  // video
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "wmv",
  // images
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "avif",
  "jxl",
  // archives / compressed
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "br",
  "lz4",
  // compressed containers
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
  "jar",
  "apk",
  "ipa",
  "dmg",
  "pdf",
]);

/** True if the file extension indicates already-compressed data. */
export function isCompressedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && COMPRESSED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Create a ZIP archive as a byte stream. Entries are consumed lazily, one at a
 * time, as the returned stream is read; nothing is buffered beyond the chunk
 * in flight and one central-directory record (~100 bytes) per entry.
 */
export function createZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipOptions = {},
): ReadableStream<Uint8Array> {
  const chunks = generate(entries, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

// ---------------------------------------------------------------------------

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
// A deflate stream can be slightly larger than its input (stored blocks:
// 5 bytes per 64 KiB, plus a few bytes). Entries whose declared size is
// within this margin of 4 GiB are written as ZIP64 so the compressed size
// cannot overflow a 32-bit field unexpectedly.
const ZIP64_SIZE_THRESHOLD = MAX32 - 0x1000000; // 4 GiB - 16 MiB

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20; // 2.0: deflate, directories
const VERSION_ZIP64 = 45; // 4.5: ZIP64
const MADE_BY_UNIX = 3 << 8;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UT = 0x5455; // Info-ZIP extended timestamp (UTC mtime)

interface Record {
  name: Uint8Array;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  mtime: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  zip64Local: boolean;
  directory: boolean;
}

async function* generate(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const crc32 = options.crc32 ?? crc32Js;
  const deflateRaw = options.deflateRaw ?? defaultDeflateRaw;
  const always = options.zip64 === "always";
  const mirror = options.experimental?.centralZip64 === "mirror";
  const zeroLocalSizes = options.experimental?.localSizes === "zero";
  const encoder = new TextEncoder();
  const records: Record[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for await (const entry of entries) {
    const path = normalizePath(entry.path);
    if (seen.has(path)) throw new Error(`zip: duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
    const name = encoder.encode(path);
    if (name.length > MAX16) throw new Error(`zip: path too long ${JSON.stringify(path)}`);

    const directory = path.endsWith("/");
    const compress =
      !directory &&
      (entry.compress ?? (options.compress === false ? false : !isCompressedPath(path)));
    const hint = entry.size;
    if (hint !== undefined && !(Number.isSafeInteger(hint) && hint >= 0)) {
      throw new Error(`zip: invalid size for ${JSON.stringify(path)}`);
    }
    const zip64Local = !directory && (always || hint === undefined || hint >= ZIP64_SIZE_THRESHOLD);
    const mtime = entry.lastModified ?? Date.now();
    const offsetMinutes = options.timeZoneOffset ?? -new Date(mtime).getTimezoneOffset();
    const [dosTime, dosDate] = toDosDateTime(new Date(mtime + offsetMinutes * 60_000));

    const record: Record = {
      name,
      flags: FLAG_UTF8 | (directory ? 0 : FLAG_DATA_DESCRIPTOR),
      method: compress ? METHOD_DEFLATE : METHOD_STORE,
      dosTime,
      dosDate,
      mtime,
      crc: 0,
      compressedSize: 0,
      size: 0,
      offset,
      zip64Local,
      directory,
    };

    const header = localHeader(record, zeroLocalSizes);
    offset += header.length;
    yield header;

    if (!directory) {
      if (!entry.stream) throw new Error(`zip: entry ${JSON.stringify(path)} has no stream()`);
      let crc = 0;
      let size = 0;
      let compressedSize = 0;
      const source = entry.stream();
      let output: ReadableStream<Uint8Array>;
      if (compress) {
        output = source
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                crc = crc32(chunk, crc);
                size += chunk.length;
                controller.enqueue(chunk);
              },
            }),
          )
          .pipeThrough(deflateRaw());
      } else {
        output = source;
      }
      const reader = output.getReader();
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array))
            throw new TypeError("zip: stream must yield Uint8Array chunks");
          if (value.length === 0) continue;
          if (!compress) {
            crc = crc32(value, crc);
            size += value.length;
          }
          compressedSize += value.length;
          offset += value.length;
          yield value;
        }
        finished = true;
      } finally {
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (hint !== undefined && size !== hint) {
        throw new Error(
          `zip: ${JSON.stringify(path)} yielded ${size} bytes, expected ${hint} (changed while reading?)`,
        );
      }
      if (!zip64Local && (size >= MAX32 || compressedSize >= MAX32)) {
        throw new Error(`zip: ${JSON.stringify(path)} exceeds 4 GiB without ZIP64 local header`);
      }
      record.crc = crc;
      record.size = size;
      record.compressedSize = compressedSize;
      const descriptor = dataDescriptor(record);
      offset += descriptor.length;
      yield descriptor;
    }
    records.push(record);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const record of records) {
    const header = centralHeader(record, always || (mirror && record.zip64Local));
    centralSize += header.length;
    yield header;
  }
  const centralEnd = centralOffset + centralSize;

  const needZip64End =
    always || records.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  if (needZip64End) {
    yield zip64EndRecord(records.length, centralSize, centralOffset);
    yield zip64EndLocator(centralEnd);
  }
  yield endRecord(records.length, centralSize, centralOffset);
}

function defaultDeflateRaw(): ByteTransform {
  if (typeof CompressionStream !== "function") {
    throw new Error("zip: CompressionStream is unavailable; pass options.deflateRaw");
  }
  return new CompressionStream("deflate-raw") as unknown as ByteTransform;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const directory = normalized.endsWith("/");
  const kept = parts.filter((part) => part !== "" && part !== ".");
  if (
    kept.length === 0 ||
    kept.includes("..") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`zip: invalid path ${JSON.stringify(path)}`);
  }
  return kept.join("/") + (directory ? "/" : "");
}

/** DOS date/time from a Date already shifted to the target zone (read with UTC getters), clamped to 1980..2107. */
function toDosDateTime(date: Date): [number, number] {
  let year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 1980) return [0, (1 << 5) | 1]; // 1980-01-01 00:00
  if (year > 2107) year = 2107;
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return [time, day];
}

function utcSeconds(mtime: number): number {
  return Math.min(Math.max(Math.floor(mtime / 1000), 0), MAX32);
}

function localHeader(r: Record, zeroSizes: boolean): Uint8Array {
  const extraLength = 9 + (r.zip64Local ? 20 : 0);
  const out = new Uint8Array(30 + r.name.length + extraLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, r.zip64Local ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  v.setUint16(6, r.flags, true);
  v.setUint16(8, r.method, true);
  v.setUint16(10, r.dosTime, true);
  v.setUint16(12, r.dosDate, true);
  // crc32 (14), compressed size (18), size (22): zero with a data descriptor,
  // except ZIP64 entries where 0xFFFFFFFF points readers at the ZIP64 extra.
  if (r.zip64Local && !zeroSizes) {
    v.setUint32(18, MAX32, true);
    v.setUint32(22, MAX32, true);
  }
  v.setUint16(26, r.name.length, true);
  v.setUint16(28, extraLength, true);
  out.set(r.name, 30);
  let p = 30 + r.name.length;
  p = writeUt(v, p, r.mtime);
  if (r.zip64Local) {
    v.setUint16(p, EXTRA_ZIP64, true);
    v.setUint16(p + 2, 16, true);
    // size and compressed size: zero, the real values follow in the data descriptor
  }
  return out;
}

function writeUt(v: DataView, p: number, mtime: number): number {
  v.setUint16(p, EXTRA_UT, true);
  v.setUint16(p + 2, 5, true);
  v.setUint8(p + 4, 1); // flags: mtime present
  v.setUint32(p + 5, utcSeconds(mtime), true);
  return p + 9;
}

function dataDescriptor(r: Record): Uint8Array {
  const out = new Uint8Array(r.zip64Local ? 24 : 16);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, r.crc, true);
  if (r.zip64Local) {
    setUint64(v, 8, r.compressedSize);
    setUint64(v, 16, r.size);
  } else {
    v.setUint32(8, r.compressedSize, true);
    v.setUint32(12, r.size, true);
  }
  return out;
}

function centralHeader(r: Record, forceZip64Sizes: boolean): Uint8Array {
  const sizeOver = forceZip64Sizes || r.size >= MAX32 || r.compressedSize >= MAX32;
  const offsetOver = r.offset >= MAX32;
  const zip64Length = (sizeOver ? 16 : 0) + (offsetOver ? 8 : 0);
  const extraLength = 9 + (zip64Length ? 4 + zip64Length : 0);
  const out = new Uint8Array(46 + r.name.length + extraLength);
  const v = new DataView(out.buffer);
  const version = zip64Length || r.zip64Local ? VERSION_ZIP64 : VERSION_DEFAULT;
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, MADE_BY_UNIX | version, true);
  v.setUint16(6, version, true);
  v.setUint16(8, r.flags, true);
  v.setUint16(10, r.method, true);
  v.setUint16(12, r.dosTime, true);
  v.setUint16(14, r.dosDate, true);
  v.setUint32(16, r.crc, true);
  v.setUint32(20, sizeOver ? MAX32 : r.compressedSize, true);
  v.setUint32(24, sizeOver ? MAX32 : r.size, true);
  v.setUint16(28, r.name.length, true);
  v.setUint16(30, extraLength, true);
  // comment length (32), disk number start (34), internal attributes (36): 0
  const mode = r.directory ? 0o40755 : 0o100644;
  v.setUint32(38, ((mode << 16) | (r.directory ? 0x10 : 0)) >>> 0, true);
  v.setUint32(42, offsetOver ? MAX32 : r.offset, true);
  out.set(r.name, 46);
  let p = writeUt(v, 46 + r.name.length, r.mtime);
  if (zip64Length) {
    v.setUint16(p, EXTRA_ZIP64, true);
    v.setUint16(p + 2, zip64Length, true);
    p += 4;
    // Only fields whose 32-bit counterpart is 0xFFFFFFFF, in spec order.
    if (sizeOver) {
      setUint64(v, p, r.size);
      setUint64(v, p + 8, r.compressedSize);
      p += 16;
    }
    if (offsetOver) setUint64(v, p, r.offset);
  }
  return out;
}

function zip64EndRecord(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(56);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06064b50, true);
  setUint64(v, 4, 44); // size of the remaining record
  v.setUint16(12, MADE_BY_UNIX | VERSION_ZIP64, true);
  v.setUint16(14, VERSION_ZIP64, true);
  // disk numbers (16, 20): 0
  setUint64(v, 24, count);
  setUint64(v, 32, count);
  setUint64(v, 40, size);
  setUint64(v, 48, offset);
  return out;
}

function zip64EndLocator(zip64EndOffset: number): Uint8Array {
  const out = new Uint8Array(20);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x07064b50, true);
  // disk with the ZIP64 end record (4): 0
  setUint64(v, 8, zip64EndOffset);
  v.setUint32(16, 1, true); // total number of disks
  return out;
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, Math.min(count, MAX16), true);
  v.setUint16(10, Math.min(count, MAX16), true);
  v.setUint32(12, Math.min(size, MAX32), true);
  v.setUint32(16, Math.min(offset, MAX32), true);
  return out;
}

function setUint64(v: DataView, p: number, value: number): void {
  v.setUint32(p, value >>> 0, true);
  v.setUint32(p + 4, Math.floor(value / 0x100000000), true);
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, reflected 0xEDB88320), slice-by-8.

const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let s = 1; s < 8; s++) {
      const prev = t[(s - 1) * 256 + n];
      t[s * 256 + n] = (prev >>> 8) ^ t[prev & 0xff];
    }
  }
  return t;
})();

/** Pure JS CRC-32 with zlib.crc32's signature: `crc32Js(data, previousCrc)`. */
export function crc32Js(data: Uint8Array, previous = 0): number {
  const t = CRC_TABLE;
  let c = ~previous;
  let i = 0;
  const n = data.length;
  const end8 = n - (n % 8);
  while (i < end8) {
    c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    c =
      t[1792 + (c & 0xff)] ^
      t[1536 + ((c >>> 8) & 0xff)] ^
      t[1280 + ((c >>> 16) & 0xff)] ^
      t[1024 + (c >>> 24)] ^
      t[768 + data[i + 4]] ^
      t[512 + data[i + 5]] ^
      t[256 + data[i + 6]] ^
      t[data[i + 7]];
    i += 8;
  }
  while (i < n) c = t[(c ^ data[i++]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
