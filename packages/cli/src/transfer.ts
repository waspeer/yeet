// Shared by the single-file upload (index.ts) and the zip upload
// (upload-zip.ts): part concurrency, the progress line and the part body.

/** Parts uploaded at the same time. Each holds one part (up to 50 MiB) in memory. */
export const CONCURRENCY = 3;

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** The progress line on stderr (only when it is a terminal): `name  42%  1.2 MB / 3.0 MB  800 KB/s`. */
export class Progress {
  private sent = 0;
  private readonly started = Date.now();
  private lastDraw = 0;
  private readonly enabled = process.stderr.isTTY;
  /** Text after the rate, e.g. "file 3 of 12". */
  note = "";

  constructor(
    private readonly label: string,
    private readonly total: number,
  ) {}

  add(bytes: number): void {
    this.set(this.sent + bytes);
  }

  set(bytes: number): void {
    this.sent = bytes;
    if (Date.now() - this.lastDraw > 100) this.draw();
  }

  draw(): void {
    if (!this.enabled) return;
    this.lastDraw = Date.now();
    const pct = this.total ? Math.min(100, (this.sent / this.total) * 100) : 100;
    const seconds = Math.max((Date.now() - this.started) / 1000, 0.001);
    const rate = formatSize(this.sent / seconds);
    process.stderr.write(
      `\r\x1b[K${this.label}  ${pct.toFixed(0).padStart(3)}%  ${formatSize(this.sent)} / ${formatSize(this.total)}  ${rate}/s` +
        (this.note ? `  ${this.note}` : ""),
    );
  }

  done(): void {
    if (this.enabled) process.stderr.write("\r\x1b[K");
  }
}

/** Wrap a buffer in a stream that reports bytes as fetch pulls them. */
export function countingStream(
  buffer: Uint8Array,
  onChunk: (bytes: number) => void,
): ReadableStream {
  const CHUNK = 256 * 1024;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close();
        return;
      }
      const chunk = buffer.subarray(offset, offset + CHUNK);
      offset += chunk.length;
      onChunk(chunk.length);
      controller.enqueue(chunk);
    },
  });
}
