// Helpers for driving the browser upload page (/upload).

import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { server } from "./env.js";

/** Log in through the real form on /upload, as a person would. */
export async function logIn(page: Page): Promise<void> {
  await page.goto("/upload");
  const field = page.locator('input[name="token"]');
  await field.fill(server.token);
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().endsWith("/login") && res.request().method() === "POST",
    ),
    field.press("Enter"),
  ]);
  // Enabled once the page script has attached its handlers.
  await expect(page.getByRole("button", { name: "Choose file" })).toBeEnabled();
}

/**
 * Drop a file on the upload page the way a drag from Finder does: a `drop`
 * event whose DataTransfer holds the File. The File comes from a helper
 * `<input type=file>` filled by Playwright, so even large files are not copied
 * through the test protocol. Dispatches dragenter/dragover/drop on the drop zone.
 */
export async function dropFile(page: Page, path: string): Promise<void> {
  await page.evaluate(() => {
    const helper = document.createElement("input");
    helper.type = "file";
    helper.id = "e2e-drop-source";
    helper.hidden = true;
    document.body.append(helper);
  });
  await page.locator("#e2e-drop-source").setInputFiles(path);
  await page.evaluate(() => {
    const helper = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const data = new DataTransfer();
    data.items.add(helper.files![0]!);
    helper.remove();
    const target = document.getElementById("drop")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  });
}

/** Drop several files at once (a real DataTransfer, as dropFile()). */
export async function dropFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const helper = document.createElement("input");
    helper.type = "file";
    helper.multiple = true;
    helper.id = "e2e-drop-source";
    helper.hidden = true;
    document.body.append(helper);
  });
  await page.locator("#e2e-drop-source").setInputFiles(paths);
  await page.evaluate(() => {
    const helper = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const data = new DataTransfer();
    for (const file of helper.files!) data.items.add(file);
    helper.remove();
    const target = document.getElementById("drop")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  });
}

/**
 * A file or folder to drop with dropTree(): a file on disk (`source`), a
 * file made in the page (`text`, with `lastModified`), or a folder
 * (`children`, with its `mtime`).
 */
export interface DropNode {
  name: string;
  source?: string;
  text?: string;
  lastModified?: number;
  children?: DropNode[];
  mtime?: number;
}

/** The DropNode of a folder on disk, as Finder would drop it (everything, .DS_Store included). */
export async function treeOf(dir: string): Promise<DropNode> {
  const children: DropNode[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const st = await stat(path);
    children.push(st.isDirectory() ? await treeOf(path) : { name, source: path });
  }
  return { name: basename(dir), children, mtime: (await stat(dir)).mtimeMs };
}

/**
 * Drop files and folders on the upload page. No test can make a browser
 * drop a real folder, so the drop event carries stand-ins for what the
 * browser hands out (webkitGetAsEntry() FileSystemEntry objects: isFile,
 * isDirectory, name, file(), createReader().readEntries() in batches, and
 * Chromium's getMetadata() for a folder's date), around real File objects:
 * those of files on disk come from a helper file input, so they are backed
 * by the file (a rename makes their reads fail, as on an iPhone).
 */
export async function dropTree(page: Page, nodes: DropNode[]): Promise<void> {
  const sources: string[] = [];
  const index = (node: DropNode): unknown => ({
    ...node,
    source: undefined,
    index: node.source ? sources.push(node.source) - 1 : undefined,
    children: node.children?.map(index),
  });
  const indexed = nodes.map(index);
  await page.evaluate(() => {
    const helper = document.createElement("input");
    helper.type = "file";
    helper.multiple = true;
    helper.id = "e2e-drop-source";
    helper.hidden = true;
    document.body.append(helper);
  });
  if (sources.length) await page.locator("#e2e-drop-source").setInputFiles(sources);
  await page.evaluate((tree) => {
    type Node = {
      name: string;
      index?: number;
      text?: string;
      lastModified?: number;
      children?: Node[];
      mtime?: number;
    };
    const helper = document.getElementById("e2e-drop-source") as HTMLInputElement;
    const files = [...(helper.files ?? [])];
    helper.remove();
    const later = (fn: () => void) => setTimeout(fn, 0);
    const make = (node: Node, parent: string): unknown => {
      const fullPath = `${parent}/${node.name}`;
      if (node.children) {
        const children = node.children;
        return {
          isFile: false,
          isDirectory: true,
          name: node.name,
          fullPath,
          createReader() {
            // Two batches, then none, as Chromium hands out 100 at a time.
            const batches = [children.slice(0, 2), children.slice(2), []];
            return {
              readEntries(ok: (entries: unknown[]) => void) {
                const batch = batches.shift() ?? [];
                later(() => ok(batch.map((child) => make(child, fullPath))));
              },
            };
          },
          getMetadata(ok: (m: { modificationTime: Date }) => void) {
            later(() => ok({ modificationTime: new Date(node.mtime ?? Date.now()) }));
          },
        };
      }
      const file =
        node.index !== undefined
          ? files[node.index]!
          : new File([node.text ?? ""], node.name, { lastModified: node.lastModified });
      return {
        isFile: true,
        isDirectory: false,
        name: node.name,
        fullPath,
        file(ok: (file: File) => void) {
          later(() => ok(file));
        },
      };
    };
    const entries = tree.map((node) => make(node as Node, ""));
    const data = {
      files: [],
      items: entries.map((entry) => ({
        kind: "file",
        type: "",
        webkitGetAsEntry: () => entry,
        getAsFile: () => null,
      })),
      types: ["Files"],
      dropEffect: "none",
    };
    const target = document.getElementById("drop")!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: data });
      target.dispatchEvent(event);
    }
  }, indexed);
}

/**
 * Record, from page load on, every value of the progress bar and the main
 * thread's responsiveness: a 10 ms setInterval whose worst lateness is kept
 * in `window.__e2e.maxLagMs` (reset with resetLag()).
 */
export async function instrumentUploadPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { progress: [] as number[], maxLagMs: 0, lagSamples: 0 };
    (window as unknown as { __e2e: typeof state }).__e2e = state;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      state.maxLagMs = Math.max(state.maxLagMs, now - last - 10);
      state.lagSamples++;
      last = now;
    }, 10);
    // Observe the whole document from the start, so no update can be missed
    // however early the page script runs (an observer attached on
    // DOMContentLoaded missed every update once in Firefox).
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLProgressElement;
        if (target.id === "bar") state.progress.push(target.value);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["value"] });
  });
}

export interface PageStats {
  progress: number[];
  maxLagMs: number;
  lagSamples: number;
}

export function pageStats(page: Page): Promise<PageStats> {
  return page.evaluate(() => (window as unknown as { __e2e: PageStats }).__e2e);
}

export async function resetStats(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __e2e: PageStats }).__e2e;
    state.progress = [];
    state.maxLagMs = 0;
    state.lagSamples = 0;
  });
}

/** Wait for the done state and return the share link shown. */
export async function shareLink(page: Page, timeout = 60_000): Promise<string> {
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible({ timeout });
  return page.locator("#link").inputValue();
}
