import { api, clientIp, expect, server, test, uploadViaApi } from "../../lib/index.js";

// Every API route must reject requests without the upload token. The ID is a
// real finished upload, so an unprotected route would answer 2xx/4xx other
// than 401 (and DELETE would actually delete it — checked at the end).
let id: string;

test.beforeAll(async () => {
  ({ id } = await uploadViaApi({ filename: "auth-target.txt", data: Buffer.from("keep me") }));
});

const routes: { method: string; path: () => string; body?: () => BodyInit }[] = [
  { method: "GET", path: () => "/api/me" },
  { method: "GET", path: () => "/api/uploads" },
  {
    method: "POST",
    path: () => "/api/uploads",
    body: () => JSON.stringify({ filename: "x.txt", size: 1, expires_in: 60 }),
  },
  { method: "PUT", path: () => `/api/uploads/${id}/parts/1`, body: () => "x" },
  {
    method: "POST",
    path: () => `/api/uploads/${id}/complete`,
    body: () => JSON.stringify({ parts: [] }),
  },
  { method: "DELETE", path: () => `/api/uploads/${id}` },
];

const credentials: { name: string; headers: () => Record<string, string> }[] = [
  { name: "no Authorization header", headers: () => ({}) },
  { name: "a wrong bearer token", headers: () => ({ Authorization: "Bearer not-the-token" }) },
  {
    name: "the right token as Basic auth",
    headers: () => ({
      Authorization: `Basic ${Buffer.from(`yeet:${server.token}`).toString("base64")}`,
    }),
  },
  {
    name: "the right token without the Bearer prefix",
    headers: () => ({ Authorization: server.token }),
  },
  // Prefix and suffix variants catch a startsWith()/includes() comparison.
  {
    name: "the token with an extra character",
    headers: () => ({ Authorization: `Bearer ${server.token}x` }),
  },
  {
    name: "the token missing its last character",
    headers: () => ({ Authorization: `Bearer ${server.token.slice(0, -1)}` }),
  },
  { name: "an empty bearer token", headers: () => ({ Authorization: "Bearer " }) },
  {
    name: "the token after two spaces",
    headers: () => ({ Authorization: `Bearer  ${server.token}` }),
  },
];

test.describe("API authentication", () => {
  for (const credential of credentials) {
    test(`every route answers 401 to ${credential.name}`, async () => {
      // Its own client address: the six failures stay below the per-IP limit
      // of 20 failed bearer attempts per minute (tested in rate-limit.spec.ts).
      const ip = clientIp();
      for (const route of routes) {
        const res = await api(route.path(), {
          method: route.method,
          token: null,
          ip,
          headers: { "Content-Type": "application/json", ...credential.headers() },
          body: route.body?.(),
        });
        expect(res.status, `${route.method} ${route.path()}`).toBe(401);
        expect(await res.json(), `${route.method} ${route.path()}`).toEqual({
          error: "Invalid upload token",
        });
      }

      // Nothing above changed the upload.
      const page = await fetch(`${server.baseURL}/${id}/auth-target.txt`);
      expect(page.status).toBe(200);
    });
  }
});
