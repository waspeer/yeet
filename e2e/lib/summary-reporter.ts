// Prints a PASS/FAIL/SKIP/FLAKY/XFAIL line per test, grouped per Playwright
// project (node, chromium, webkit, firefox), and writes results/summary.json.
//
// Overall status: "failed" if any test failed or was flaky, or the run did not
// finish normally; "incomplete" if nothing failed but something was skipped or
// is marked test.fail() (an expected failure verifies nothing); "passed" only
// if every selected test ran and passed on its first attempt.

import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Outcome = "passed" | "failed" | "skipped" | "flaky" | "expectedFailure";

interface TestEntry {
  project: string;
  file: string;
  title: string;
  tags: string[];
  outcome: Outcome;
  durationMs: number;
  attempts: number;
  error?: string;
}

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SUMMARY_PATH = join(E2E_DIR, "results", "summary.json");
const LABEL: Record<Outcome, string> = {
  passed: "PASS ",
  failed: "FAIL ",
  skipped: "SKIP ",
  flaky: "FLAKY",
  expectedFailure: "XFAIL",
};

function outcomeOf(test: TestCase): Outcome {
  switch (test.outcome()) {
    case "expected":
      // test.fail(): it failed as declared, which proves nothing about the product.
      return test.expectedStatus === "failed" ? "expectedFailure" : "passed";
    case "flaky":
      return "flaky";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

/** The gist of an error: its first three non-empty lines, without ANSI colors. */
function briefError(text: string | undefined): string | undefined {
  // oxlint-disable-next-line no-control-regex
  const clean = text?.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return lines?.join(" | ").slice(0, 400);
}

export default class SummaryReporter implements Reporter {
  private suite: Suite | undefined;
  private started = Date.now();
  private config: FullConfig | undefined;

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.started = Date.now();
  }

  printsToStdio(): boolean {
    return true;
  }

  onEnd(result: FullResult): void {
    const tests: TestEntry[] = (this.suite?.allTests() ?? []).map((test) => {
      const results = test.results;
      const last = results[results.length - 1];
      const failed = results.find((r) => r.status === "failed" || r.status === "timedOut");
      const error = failed?.error ?? last?.error;
      return {
        project: test.parent.project()?.name ?? "(none)",
        file: relative(E2E_DIR, test.location.file),
        title: test.titlePath().slice(3).join(" › "),
        tags: test.tags,
        outcome: outcomeOf(test),
        durationMs: results.reduce((sum, r) => sum + r.duration, 0),
        attempts: results.length,
        ...(outcomeOf(test) !== "passed" && error
          ? { error: briefError(error.message ?? error.value) }
          : {}),
        ...(last?.status === "interrupted" ? { error: "interrupted" } : {}),
      };
    });

    const empty = () => ({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      expectedFailure: 0,
    });
    const totals = empty();
    const projects: Record<string, ReturnType<typeof empty>> = {};
    for (const entry of tests) {
      const project = (projects[entry.project] ??= empty());
      for (const bucket of [totals, project]) {
        bucket.total++;
        bucket[entry.outcome]++;
      }
    }

    let status: "passed" | "failed" | "incomplete" | "interrupted";
    if (result.status === "interrupted") status = "interrupted";
    else if (result.status !== "passed" || totals.failed > 0 || totals.flaky > 0) {
      status = "failed";
    } else if (totals.total === 0 || totals.skipped > 0 || totals.expectedFailure > 0) {
      status = "incomplete";
    } else status = "passed";

    const out: string[] = ["", "=== yeet e2e summary ==="];
    for (const [name, counts] of Object.entries(projects)) {
      out.push(
        "",
        `${name}: ${counts.passed}/${counts.total} passed` +
          (counts.failed ? `, ${counts.failed} FAILED` : "") +
          (counts.flaky ? `, ${counts.flaky} FLAKY` : "") +
          (counts.skipped ? `, ${counts.skipped} skipped` : "") +
          (counts.expectedFailure
            ? `, ${counts.expectedFailure} expected failure (test.fail)`
            : ""),
      );
      for (const entry of tests.filter((t) => t.project === name)) {
        const seconds = (entry.durationMs / 1000).toFixed(1).padStart(5);
        out.push(`  ${LABEL[entry.outcome]} ${seconds}s  ${entry.file} › ${entry.title}`);
        if (entry.error) out.push(`               ${entry.error}`);
      }
    }
    if (totals.total === 0) out.push("", "No tests ran (check --grep / --project filters).");
    out.push(
      "",
      `Overall: ${status.toUpperCase()} — ${totals.passed} passed, ${totals.failed} failed, ` +
        `${totals.flaky} flaky, ${totals.skipped} skipped, ` +
        `${totals.expectedFailure} expected failure of ${totals.total} ` +
        `in ${((Date.now() - this.started) / 1000).toFixed(1)}s ` +
        `(playwright status: ${result.status})`,
      "",
    );
    process.stdout.write(out.join("\n") + "\n");

    mkdirSync(dirname(SUMMARY_PATH), { recursive: true });
    writeFileSync(
      SUMMARY_PATH,
      JSON.stringify(
        {
          status,
          playwrightStatus: result.status,
          startedAt: new Date(this.started).toISOString(),
          durationMs: Date.now() - this.started,
          workers: this.config?.workers,
          totals,
          projects,
          tests,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
