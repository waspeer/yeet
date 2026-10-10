// A stand-in yeet server for CLI tests: it records every request and
// answers like the Worker's upload API, with any part size (tiny ones make
// small files take many parts), and a hook to act on a request (change a
// file, hold or fail the answer). Used by tests/node/cli-zip*.spec.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  body: Buffer;
  json?: Record<string, unknown>;
  /** When the whole request had arrived, and when it was answered (performance.now()). */
  receivedAt: number;
  answeredAt?: number;
}

/**
 * A stand-in yeet server with a tiny part size. `onRequest` may act on a
 * request (change a file, hold the answer) and return a status to send
 * instead of the normal answer. Uploads are named up1, up2, … in the order
 * they are created.
 */
export async function standIn(
  partSize: number,
  onRequest?: (
    r: Recorded,
  ) => Promise<number | "hold" | undefined | void> | number | "hold" | undefined | void,
) {
  const requests: Recorded[] = [];
  let created = 0;
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", async () => {
      const path = new URL(req.url!, "http://x").pathname;
      const body = Buffer.concat(chunks);
      const r: Recorded = { method: req.method!, path, body, receivedAt: performance.now() };
      if (req.headers["content-type"] === "application/json" && body.length)
        r.json = JSON.parse(body.toString());
      requests.push(r);
      const override = await onRequest?.(r);
      if (override === "hold") return;
      const part = path.match(/\/parts\/(\d+)$/);
      const id = path.match(/^\/api\/uploads\/([^/]+)/)?.[1];
      const status =
        typeof override === "number"
          ? override
          : req.method === "POST" && path === "/api/uploads"
            ? 201
            : 200;
      const reply =
        status >= 400
          ? { error: "stand-in error" }
          : req.method === "POST" && path === "/api/uploads"
            ? { id: `up${++created}`, part_size: partSize }
            : part
              ? { part_number: Number(part[1]), etag: `e${part[1]}` }
              : path.endsWith("/complete")
                ? { url: `http://127.0.0.1/${id}/stand-in.zip` }
                : { deleted: id };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
      r.answeredAt = performance.now();
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    env: { YEET_URL: url, YEET_TOKEN: "a-token-of-16-chars-or-more" },
    puts: () => requests.filter((r) => r.method === "PUT"),
    /** The first create (POST /api/uploads), and all of them. */
    create: () => requests.find((r) => r.method === "POST" && r.path === "/api/uploads"),
    creates: () => requests.filter((r) => r.method === "POST" && r.path === "/api/uploads"),
    completes: () => requests.filter((r) => r.path.endsWith("/complete")),
    deletes: () => requests.filter((r) => r.method === "DELETE"),
    /** The parts in order, concatenated: the zip as the server would store it. */
    zip: () =>
      Buffer.concat(
        requests
          .filter((r) => r.method === "PUT")
          .sort((a, b) => Number(a.path.split("/").pop()) - Number(b.path.split("/").pop()))
          .map((r) => r.body),
      ),
    close: async () => {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    },
  };
}

export type StandIn = Awaited<ReturnType<typeof standIn>>;
