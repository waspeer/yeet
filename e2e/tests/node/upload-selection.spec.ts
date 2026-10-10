// What the upload page zips (packages/worker/src/upload/selection.ts, round
// 2C+2), imported directly: the same rules as the CLI's planUpload() (one
// file as-is, `<folder>.zip` or `yeet-<timestamp>.zip`, .DS_Store skipped,
// empty folders kept, NFC, sanitizeForWindows, collisions refused, an empty
// selection refused), and how the zip's size is handled (stored → size at
// create; deflated → size at complete, at most MAX_UNSIZED_PARTS parts even
// in deflate's worst case; too large for that → everything stored).
// The browser side (pickers, drops, the worker) is tests/browser/upload-zip.spec.ts.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  planUpload,
  timestampName as cliTimestampName,
} from "../../../packages/cli/src/selection.js";
import {
  deflateBound,
  MAX_UNSIZED_PARTS as PAGE_MAX_UNSIZED_PARTS,
  PART_SIZE as PAGE_PART_SIZE,
  planSelection,
  sameZip,
  SelectionError,
  timestampName,
  worstCaseZipSize,
  zipEntries,
  type Picked,
  type Plan,
  type ZipPlan,
} from "../../../packages/worker/src/upload/selection.js";
import { MAX_UNSIZED_PARTS } from "../../../packages/worker/src/uploads.js";
import { createZip, storedZipSize } from "../../../packages/worker/src/zip.js";
import { expect, MiB, test } from "../../lib/index.js";

/** `part_size` of POST /api/uploads (PART_SIZE in packages/worker/src/index.ts, docs/design/api.md). */
const PART_SIZE = 52_428_800;
const OPTS = { partSize: PART_SIZE, maxUnsizedParts: MAX_UNSIZED_PARTS };
const T = Date.UTC(2026, 9, 10, 12, 0, 0);

const file = (name: string, content: string | Uint8Array = "x", lastModified = T) =>
  new File([content as BlobPart], name, { lastModified });

/** Loose files, as the file picker gives them. */
const loose = (...files: File[]): Picked => ({
  tops: files.map((f) => ({ name: f.name, isDir: false })),
  files: files.map((f) => ({ file: f, path: f.name })),
  dirs: [],
});

/** One folder, as the folder picker gives it (paths from the folder's parent). */
const folder = (
  name: string,
  files: Record<string, string | Uint8Array>,
  dirs: string[] = [],
): Picked => ({
  tops: [{ name, isDir: true }],
  files: Object.entries(files).map(([path, content]) => ({
    file: file(path.split("/").pop()!, content),
    path: `${name}/${path}`,
  })),
  dirs: dirs.map((path) => ({ path: `${name}/${path}`, lastModified: T - 1000 })),
});

function zip(plan: Plan): ZipPlan {
  if (plan.kind !== "zip") throw new Error(`expected a zip, got ${plan.kind}`);
  return plan;
}

const paths = (plan: ZipPlan) => [
  ...plan.files.map((f) => f.path),
  ...plan.dirs.map((d) => d.path),
];

async function zipBytes(plan: ZipPlan): Promise<Uint8Array> {
  const entries = zipEntries(plan, (f) => f.file.stream() as ReadableStream<Uint8Array>);
  return new Uint8Array(await new Response(createZip(entries)).arrayBuffer());
}

test.describe("upload page: what gets zipped", () => {
  test("one file is uploaded as it is", () => {
    const f = file("song.wav");
    expect(planSelection(loose(f), OPTS)).toEqual({ kind: "file", file: f });
  });

  test("a folder: <folder>.zip with the folder as the single top-level entry, even with one file", () => {
    const plan = zip(planSelection(folder("Stems v2", { "kick.wav": "k" }), OPTS));
    expect(plan.name).toBe("Stems v2.zip");
    expect(plan.folder).toBe(true);
    expect(paths(plan)).toEqual(["Stems v2/kick.wav"]);
  });

  test("several files: yeet-<timestamp>.zip in local time, as the CLI names it", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5);
    const plan = zip(planSelection(loose(file("a.wav"), file("b.txt")), { ...OPTS, now }));
    expect(plan.name).toBe("yeet-20260102-030405.zip");
    expect(timestampName(now)).toBe(cliTimestampName(now));
    expect(plan.folder).toBe(false);
    expect(paths(plan)).toEqual(["a.wav", "b.txt"]);
  });

  test(".DS_Store is skipped; empty folders (also one with only .DS_Store) are kept", () => {
    const plan = zip(
      planSelection(
        folder(
          "Album",
          {
            ".DS_Store": "x",
            "drums/.DS_Store": "x",
            "drums/kick.wav": "k",
            "only-ds/.DS_Store": "x",
          },
          ["drums", "empty", "empty/deeper", "only-ds"],
        ),
        OPTS,
      ),
    );
    expect(paths(plan)).toEqual(["Album/drums/kick.wav", "Album/empty/deeper/", "Album/only-ds/"]);
    // A walked folder's date is kept; one only seen in paths gets "now".
    const now = new Date(T + 5000);
    const picked = folder("A", { "x/.DS_Store": "x", "f.txt": "f" });
    expect(zip(planSelection(picked, { ...OPTS, now })).dirs).toEqual([
      { path: "A/x/", lastModified: now.getTime() },
    ]);
    expect(zip(planSelection(folder("A", { "f.txt": "f" }, ["e"]), OPTS)).dirs).toEqual([
      { path: "A/e/", lastModified: T - 1000 },
    ]);
  });

  test("paths are NFC and safe for Windows, with a note; files are sorted folder by folder", () => {
    const nfd = "Café";
    const plan = zip(
      planSelection(
        folder(nfd, {
          "b/z.txt": "z",
          "a:b?.txt": "q",
          "CON.txt": "c",
          "a/b.txt": "b",
          "trailing. ": "t",
        }),
        OPTS,
      ),
    );
    expect(plan.name).toBe("Café.zip");
    // Sorted by the names as chosen, folder by folder ("a/b.txt" before "a:b?.txt").
    expect(plan.files.map((f) => f.path)).toEqual([
      "Café/_CON.txt",
      "Café/a/b.txt",
      "Café/a_b_.txt",
      "Café/b/z.txt",
      "Café/trailing",
    ]);
    expect(plan.warnings).toEqual([
      "Renamed 3 names so Windows can unzip them: Café/CON.txt → Café/_CON.txt, " +
        "Café/a:b?.txt → Café/a_b_.txt, Café/trailing.  → Café/trailing",
    ]);
  });

  test("a very long path is noted", () => {
    const long = `${"x".repeat(300)}.txt`;
    const plan = zip(planSelection(folder("F", { [long]: "x" }), OPTS));
    expect(plan.warnings).toEqual([
      expect.stringMatching(/characters long; Windows may not unzip it\.$/),
    ]);
  });

  const collisions: [string, Picked][] = [
    ["case", folder("F", { "Kick.wav": "a", "kick.wav": "b" })],
    ["NFC", folder("F", { "Café.txt": "a", "Café.txt": "b" })],
    ["sanitizing", folder("F", { "a:b.txt": "a", "a_b.txt": "b" })],
    [
      "a file and a folder (case only)",
      {
        tops: [
          { name: "a", isDir: false },
          { name: "A", isDir: true },
        ],
        files: [
          { file: file("a"), path: "a" },
          { file: file("x.txt"), path: "A/x.txt" },
        ],
        dirs: [{ path: "A" }],
      },
    ],
    ["a file and a folder inside a folder", folder("F", { Sub: "a", "sub/x.txt": "b" })],
  ];
  for (const [what, picked] of collisions) {
    test(`a name collision (${what}) is refused, naming both`, () => {
      let error: unknown;
      try {
        planSelection(picked, OPTS);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SelectionError);
      expect((error as Error).message).toMatch(
        /^“.+” and “.+” would have the same name in the zip \(“.+”; upper and lower case count as the same, .*Rename one of them and try again\.$/,
      );
    });
  }

  test("nothing to upload: only empty folders or .DS_Store, or an empty folder", () => {
    for (const picked of [
      folder("F", { ".DS_Store": "x" }, ["empty"]),
      { tops: [{ name: "", isDir: true }], files: [], dirs: [] },
      { tops: [{ name: "F", isDir: true }], files: [], dirs: [{ path: "F" }] },
    ] satisfies Picked[]) {
      expect(() => planSelection(picked, OPTS)).toThrow(
        new SelectionError(
          "There is nothing to upload: no files were chosen, only empty folders (.DS_Store files are left out).",
        ),
      );
    }
  });

  test("the same selection as the CLI's planUpload() of a folder on disk", async ({ tmp }) => {
    const root = join(tmp, "Ünïcødé stems – 名前 (v2) #1");
    for (const [path, content] of Object.entries({
      "it's (really) #1 & 50% done!.txt": "p",
      "drums/kick.mp3": "k",
      "drums/.DS_Store": "d",
      "drums/deep/er/snare.wav": "s",
      "what?.txt": "w",
    })) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await mkdir(join(root, "empty"), { recursive: true });
    // As the drop walker sees it.
    const picked: Picked = {
      tops: [{ name: root.split("/").pop()!, isDir: true }],
      files: [],
      dirs: [],
    };
    const walk = async (dir: string, path: string) => {
      picked.dirs.push({ path, lastModified: (await stat(dir)).mtimeMs });
      for (const name of await readdir(dir)) {
        const st = await stat(join(dir, name));
        if (st.isDirectory()) await walk(join(dir, name), `${path}/${name}`);
        else
          picked.files.push({
            file: file(name, await readFile(join(dir, name))),
            path: `${path}/${name}`,
          });
      }
    };
    await walk(root, picked.tops[0]!.name);
    const page = zip(planSelection(picked, OPTS));
    const cli = await planUpload([root]);
    if (cli.kind !== "zip") throw new Error("expected a zip");
    expect(page.name).toBe(cli.name);
    expect(page.files.map((f) => f.path).sort()).toEqual(cli.files.map((f) => f.path).sort());
    expect(page.dirs.map((d) => d.path)).toEqual(cli.dirs.map((d) => d.path));
    expect(page.warnings).toEqual(cli.warnings);
  });
});

test.describe("upload page: the zip's size", () => {
  test("the page's limits are the server's", () => {
    expect(PAGE_MAX_UNSIZED_PARTS).toBe(MAX_UNSIZED_PARTS);
    expect(PAGE_PART_SIZE).toBe(PART_SIZE);
  });

  test("only already-compressed (or empty) files: stored, the exact size known up front", async () => {
    const plan = zip(
      planSelection(
        folder("Mix", { "a.mp3": randomBytes(5000), "b.JPG": "j", "notes.txt": "" }),
        OPTS,
      ),
    );
    expect(plan.files.map((f) => f.compress)).toEqual([false, false, false]);
    expect(plan.compressible).toBe(false);
    expect(plan.forcedStore).toBe(false);
    expect(plan.size).toBe((await zipBytes(plan)).length);
  });

  test("compressible files: deflated, the size left for complete, the worst case within 150 parts", async () => {
    const plan = zip(
      planSelection(
        folder("Mix", { "a.wav": randomBytes(3 * MiB), "b.mp3": randomBytes(1000) }),
        OPTS,
      ),
    );
    expect(plan.files.map((f) => f.compress)).toEqual([true, false]);
    expect(plan.size).toBeUndefined();
    expect(plan.forcedStore).toBe(false);
    // Random data does not compress: the real zip stays below the bound.
    const bytes = await zipBytes(plan);
    expect(bytes.length).toBeGreaterThan(3 * MiB);
    expect(bytes.length).toBeLessThanOrEqual(plan.worstCase!);
    expect(plan.worstCase).toBe(worstCaseZipSize(plan));
  });

  test("too large for an upload of unknown size: everything stored, the size known", async () => {
    // 3 parts of 1 MiB allowed; 3 MiB of WAV could deflate to more (worst case).
    const opts = { partSize: MiB, maxUnsizedParts: 3 };
    const picked = folder("Big", { "a.wav": new Uint8Array(3 * MiB), "b.mp3": "m" });
    const plan = zip(planSelection(picked, opts));
    expect(plan.forcedStore).toBe(true);
    expect(plan.compressible).toBe(true);
    expect(plan.files.map((f) => f.compress)).toEqual([false, false]);
    expect(plan.size).toBe((await zipBytes(plan)).length);
    // Just below: deflated.
    const small = zip(
      planSelection(folder("Big", { "a.wav": new Uint8Array(3 * MiB - 128 * 1024) }), opts),
    );
    expect(small.forcedStore).toBe(false);
    expect(small.worstCase).toBeLessThanOrEqual(3 * MiB);
    // Only stored files that large: no "forced" store, nothing to warn about.
    const mp3 = zip(planSelection(folder("Big", { "a.mp3": new Uint8Array(4 * MiB) }), opts));
    expect(mp3.forcedStore).toBe(false);
    expect(mp3.size).toBeDefined();
  });

  test("the deflate bound: 4 × zlib's 0.03 % plus 1 KiB, never below the input", () => {
    expect(deflateBound(0)).toBe(1024);
    expect(deflateBound(4096)).toBe(4096 + 5 + 1024);
    expect(deflateBound(150 * PART_SIZE) / (150 * PART_SIZE)).toBeLessThan(1.0013);
  });

  test("more than R2's 10,000 parts is refused before anything is uploaded", () => {
    const big = {
      file: { size: 10_001 * 1000, lastModified: T, name: "x.mp3" } as File,
      path: "F/x.mp3",
    };
    expect(() =>
      planSelection(
        { tops: [{ name: "F", isDir: true }], files: [big], dirs: [] },
        { partSize: 1000, maxUnsizedParts: 150 },
      ),
    ).toThrow(/^This selection is too large to upload: /);
  });

  test("sameZip: the same files, sizes, dates and storage, and nothing else", () => {
    const a = zip(planSelection(folder("F", { "a.mp3": "1", "b.mp3": "22" }), OPTS));
    const b = zip(planSelection(folder("F", { "a.mp3": "1", "b.mp3": "22" }), OPTS));
    expect(sameZip(a, b)).toBe(true);
    const other = zip(planSelection(folder("F", { "a.mp3": "1", "b.mp3": "23x" }), OPTS));
    expect(sameZip(a, other)).toBe(false);
    const later: Picked = folder("F", { "a.mp3": "1", "b.mp3": "22" });
    later.files[1]!.file = file("b.mp3", "22", T + 2000);
    expect(sameZip(a, zip(planSelection(later, OPTS)))).toBe(false);
    expect(storedZipSize(zipEntries(a))).toBe(a.size);
  });

  // Verifier 2C+2: an empty folder renamed (same count, same files) is another zip.
  test("sameZip: another empty folder (same number of them) is not the same zip", () => {
    const a = zip(planSelection(folder("F", { "a.mp3": "1" }, ["empty-1"]), OPTS));
    const b = zip(planSelection(folder("F", { "a.mp3": "1" }, ["empty-2"]), OPTS));
    expect(sameZip(a, b)).toBe(false);
    expect(sameZip(a, zip(planSelection(folder("F", { "a.mp3": "1" }, ["empty-1"]), OPTS)))).toBe(
      true,
    );
  });
});
