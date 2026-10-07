// Helpers for driving the browser upload page (/upload).

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
    document.addEventListener("DOMContentLoaded", () => {
      const bar = document.getElementById("bar") as HTMLProgressElement | null;
      if (!bar) return;
      new MutationObserver(() => state.progress.push(bar.value)).observe(bar, {
        attributes: true,
        attributeFilter: ["value"],
      });
    });
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
