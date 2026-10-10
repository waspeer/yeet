// Streaming ZIP writer built on Web Streams. See docs/design/zip.md.
//
// This file exists twice, byte for byte: packages/cli/src/zip.ts and
// packages/worker/src/zip.ts. Edit one, copy it over the other;
// scripts/check-zip-copies.mjs fails when they differ.
//
// Isomorphic by construction: the only globals used are ReadableStream,
// TransformStream, TextEncoder, Uint8Array/DataView and (as an overridable
// default) CompressionStream. Anything runtime-specific (a faster deflate, a
// native CRC-32) is injected through options. No imports, no dependencies.
//
// Output layout per file entry (sizes are unknown when the header is
// written, so general purpose bit 3 is always set for file entries):
//
//   local file header | file data | data descriptor
//
// followed by the central directory, a ZIP64 end of central directory
// record + locator when needed, and the end of central directory record.

/** One file (or directory, when `path` ends in "/") to add to the archive. */
export interface ZipEntry {
  /** Relative path inside the archive, "/"-separated. A trailing "/" marks a directory. */
  path: string;
  /** Modification time in milliseconds since the epoch. Defaults to the time the entry is written. */
  lastModified?: number;
  /**
   * Uncompressed size in bytes, if known up front (fs.stat, File.size). When
   * given and below the ZIP64 threshold the entry is written without ZIP64
   * structures; the stream must then yield exactly this many bytes or the
   * archive errors (which also catches files that change while being read).
   * When omitted the entry is written with ZIP64 local fields (safe for any size).
   */
  size?: number;
  /** Deflate this entry. Defaults to `options.compress`, then to the extension heuristic. */
  compress?: boolean;
  /** Entry contents. Called once, when the entry is reached. Not called for directories. */
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
   * `false`: store everything (the CLI's --store).
   */
  compress?: boolean;
  /** Factory for a raw-deflate transform. Defaults to `new CompressionStream("deflate-raw")`. */
  deflateRaw?: () => ByteTransform;
  /** CRC-32 update function with zlib's signature `(data, previous) => crc`. Defaults to `crc32Js`. */
  crc32?: (data: Uint8Array, previous: number) => number;
  /**
   * Minutes east of UTC used for the DOS date/time fields, which have no
   * time zone and are shown as-is by readers that ignore the UTC timestamp
   * extra field (measured: ditto; reportedly Windows Explorer). Defaults to
   * the producer's local offset at each entry's mtime (always 0 in workerd).
   */
  timeZoneOffset?: number;
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
 *
 * The stream errors on an invalid or duplicate path, a source error, or a
 * size that does not match `entry.size`. Output written before the error is
 * a truncated archive: callers must discard it (the CLI aborts the upload).
 * Cancelling the stream cancels the current entry's source.
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

/**
 * The exact size of the archive `createZip(entries, options)` writes, when
 * that is known up front: every file entry is stored (not deflated) and
 * declares its `size`. Otherwise undefined (deflated output has no size
 * until it is written). Lets an uploader announce the size before streaming.
 * Validates paths like createZip, except for duplicates (createZip throws on
 * those when it gets there).
 */
export function storedZipSize(
  entries: Iterable<ZipEntry>,
  options: ZipOptions = {},
): number | undefined {
  const encoder = new TextEncoder();
  let offset = 0;
  let centralSize = 0;
  let count = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    const nameLength = encoder.encode(path).length;
    const directory = path.endsWith("/");
    const size = directory ? 0 : entry.size;
    if (size === undefined || resolveCompress(entry, path, directory, options)) return undefined;
    const zip64Local = !directory && size >= ZIP64_SIZE_THRESHOLD;
    const localOffset = offset;
    offset += 30 + nameLength + UT_LENGTH + (zip64Local ? 20 : 0) + size;
    if (!directory) offset += zip64Local ? 24 : 16;
    // Stored: compressed size = size.
    const zip64Fields = (size >= MAX32 ? 16 : 0) + (localOffset >= MAX32 ? 8 : 0);
    centralSize += 46 + nameLength + UT_LENGTH + (zip64Fields ? 4 + zip64Fields : 0);
    count++;
  }
  const zip64End = count >= MAX16 || offset >= MAX32 || centralSize >= MAX32;
  return offset + centralSize + (zip64End ? 56 + 20 : 0) + 22;
}

// ---------------------------------------------------------------------------

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
// A deflate stream can be slightly larger than its input (stored blocks:
// 5 bytes per 64 KiB, plus a few bytes; measured +0.03 % on random data).
// Entries whose declared size is within this margin of 4 GiB are written
// as ZIP64 so the compressed size cannot overflow a 32-bit field.
const ZIP64_SIZE_THRESHOLD = MAX32 - 0x1000000; // 4 GiB - 16 MiB - 1 (0xFEFFFFFF)

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20; // 2.0: deflate, directories
const VERSION_ZIP64 = 45; // 4.5: ZIP64
const MADE_BY_UNIX = 3 << 8;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UT = 0x5455; // Info-ZIP extended timestamp (UTC mtime)
const UT_LENGTH = 9; // 4-byte extra header + flags + mtime

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

function resolveCompress(
  entry: ZipEntry,
  path: string,
  directory: boolean,
  options: ZipOptions,
): boolean {
  if (directory) return false;
  return entry.compress ?? (options.compress === false ? false : !isCompressedPath(path));
}

async function* generate(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  options: ZipOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const crc32 = options.crc32 ?? crc32Js;
  const deflateRaw = options.deflateRaw ?? defaultDeflateRaw;
  const encoder = new TextEncoder();
  const records: Record[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for await (const entry of entries) {
    const path = normalizePath(entry.path);
    // Case-insensitive: such entries overwrite each other when extracted on
    // macOS (default APFS) and Windows.
    const key = path.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`zip: duplicate path ${JSON.stringify(path)} (NFC, case-insensitive)`);
    }
    seen.add(key);
    const name = encoder.encode(path);
    if (name.length > MAX16) throw new Error(`zip: path too long ${JSON.stringify(path)}`);

    const directory = path.endsWith("/");
    const compress = resolveCompress(entry, path, directory, options);
    const hint = entry.size;
    if (hint !== undefined && !(Number.isSafeInteger(hint) && hint >= 0)) {
      throw new Error(`zip: invalid size for ${JSON.stringify(path)}`);
    }
    const zip64Local = !directory && (hint === undefined || hint >= ZIP64_SIZE_THRESHOLD);
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

    if (!directory && !entry.stream) {
      throw new Error(`zip: entry ${JSON.stringify(path)} has no stream()`);
    }
    const header = localHeader(record);
    offset += header.length;
    yield header;

    if (!directory) {
      let crc = 0;
      let size = 0;
      let compressedSize = 0;
      const source = entry.stream!();
      let output: ReadableStream<Uint8Array>;
      if (compress) {
        output = source
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                if (!(chunk instanceof Uint8Array)) {
                  throw new TypeError("zip: stream must yield Uint8Array chunks");
                }
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
          if (!(value instanceof Uint8Array)) {
            throw new TypeError("zip: stream must yield Uint8Array chunks");
          }
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
      // Unreachable with an honest size hint and a real deflater (see
      // ZIP64_SIZE_THRESHOLD), but a 32-bit descriptor would silently
      // truncate the sizes, so refuse rather than write a corrupt archive.
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
    const header = centralHeader(record);
    centralSize += header.length;
    yield header;
  }
  const centralEnd = centralOffset + centralSize;

  if (records.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32) {
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

/**
 * NFC-normalize and validate a path. "/" is the only separator; a backslash
 * is an ordinary filename character (legal on macOS and Linux). It is
 * replaced only by `sanitizeForWindows`, never silently turned into a separator.
 */
function normalizePath(path: string): string {
  const normalized = path.normalize("NFC");
  const directory = normalized.endsWith("/");
  const kept = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (kept.length === 0 || kept.includes("..") || normalized.startsWith("/")) {
    throw new Error(`zip: invalid path ${JSON.stringify(path)}`);
  }
  return kept.join("/") + (directory ? "/" : "");
}

const WINDOWS_ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/g; // oxlint-disable-line no-control-regex
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/**
 * Make a "/"-separated path extractable by Windows Explorer: replaces
 * < > : " \ | ? * and control characters with "_", strips trailing dots and
 * spaces from each segment (a segment left empty becomes "_"), and prefixes
 * reserved device names (CON, NUL, COM1, LPT1, also with an extension) with
 * "_". Not applied by createZip; callers opt in. Collisions it creates are
 * caught by createZip's duplicate check. Paths of 260+ characters are left
 * alone (callers should warn about them instead).
 */
export function sanitizeForWindows(path: string): string {
  const directory = path.endsWith("/");
  const segments = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      let s = segment.replace(WINDOWS_ILLEGAL, "_").replace(/[. ]+$/, "");
      if (s === "") s = "_";
      if (WINDOWS_RESERVED.test(s)) s = "_" + s;
      return s;
    });
  return segments.join("/") + (directory ? "/" : "");
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

/** UT mtime is read as signed 32-bit by Info-ZIP and others: clamp to 1970..2038-01-19. */
function utcSeconds(mtime: number): number {
  return Math.min(Math.max(Math.floor(mtime / 1000), 0), 0x7fffffff);
}

function localHeader(r: Record): Uint8Array {
  const extraLength = UT_LENGTH + (r.zip64Local ? 20 : 0);
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
  if (r.zip64Local) {
    v.setUint32(18, MAX32, true);
    v.setUint32(22, MAX32, true);
  }
  v.setUint16(26, r.name.length, true);
  v.setUint16(28, extraLength, true);
  out.set(r.name, 30);
  // The ZIP64 extra goes first: Windows 7 Explorer reportedly only finds it there.
  let p = 30 + r.name.length;
  if (r.zip64Local) {
    v.setUint16(p, EXTRA_ZIP64, true);
    v.setUint16(p + 2, 16, true);
    // size and compressed size: zero, the real values follow in the data descriptor
    p += 20;
  }
  writeUt(v, p, r.mtime);
  return out;
}

function writeUt(v: DataView, p: number, mtime: number): void {
  v.setUint16(p, EXTRA_UT, true);
  v.setUint16(p + 2, 5, true);
  v.setUint8(p + 4, 1); // flags: mtime present
  v.setUint32(p + 5, utcSeconds(mtime), true);
}

/** Descriptor with signature; 8-byte sizes iff the local header has a ZIP64 extra (APPNOTE 4.3.9). */
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

function centralHeader(r: Record): Uint8Array {
  // Only the fields that overflow go into the ZIP64 extra (APPNOTE 4.5.3);
  // ditto rejects stored entries with unneeded ZIP64 sizes.
  const sizeOver = r.size >= MAX32;
  const compressedOver = r.compressedSize >= MAX32;
  const offsetOver = r.offset >= MAX32;
  const zip64Length = (sizeOver ? 8 : 0) + (compressedOver ? 8 : 0) + (offsetOver ? 8 : 0);
  const extraLength = UT_LENGTH + (zip64Length ? 4 + zip64Length : 0);
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
  v.setUint32(20, compressedOver ? MAX32 : r.compressedSize, true);
  v.setUint32(24, sizeOver ? MAX32 : r.size, true);
  v.setUint16(28, r.name.length, true);
  v.setUint16(30, extraLength, true);
  // comment length (32), disk number start (34), internal attributes (36): 0
  const mode = r.directory ? 0o40755 : 0o100644;
  v.setUint32(38, ((mode << 16) | (r.directory ? 0x10 : 0)) >>> 0, true);
  v.setUint32(42, offsetOver ? MAX32 : r.offset, true);
  out.set(r.name, 46);
  let p = 46 + r.name.length;
  if (zip64Length) {
    // First extra field (see localHeader).
    v.setUint16(p, EXTRA_ZIP64, true);
    v.setUint16(p + 2, zip64Length, true);
    p += 4;
    // In spec order: size, compressed size, offset.
    if (sizeOver) {
      setUint64(v, p, r.size);
      p += 8;
    }
    if (compressedOver) {
      setUint64(v, p, r.compressedSize);
      p += 8;
    }
    if (offsetOver) {
      setUint64(v, p, r.offset);
      p += 8;
    }
  }
  writeUt(v, p, r.mtime);
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
      const prev = t[(s - 1) * 256 + n]!;
      t[s * 256 + n] = (prev >>> 8) ^ t[prev & 0xff]!;
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
    c ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
    c =
      t[1792 + (c & 0xff)]! ^
      t[1536 + ((c >>> 8) & 0xff)]! ^
      t[1280 + ((c >>> 16) & 0xff)]! ^
      t[1024 + (c >>> 24)]! ^
      t[768 + data[i + 4]!]! ^
      t[512 + data[i + 5]!]! ^
      t[256 + data[i + 6]!]! ^
      t[data[i + 7]!]!;
    i += 8;
  }
  while (i < n) c = t[(c ^ data[i++]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
