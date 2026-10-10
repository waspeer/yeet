// The server API client: requests with readable errors, and retries of
// transient failures. Moved out of index.ts so the upload modules can use it.

export interface Config {
  url: string;
  token: string;
}

/** Wait `ms`; an abort of `signal` ends the wait early with the signal's reason. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The message without advice to run `yeet login`, for `yeet login` itself. */
    readonly forLogin = message,
    /** Seconds the server asked to wait before trying again (Retry-After), if it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * The three spellings of an HTTP date (RFC 9110 §5.6.7): IMF-fixdate
 * ("Sun, 06 Nov 1994 08:49:37 GMT"), RFC 850 ("Sunday, 06-Nov-94 08:49:37
 * GMT") and asctime ("Sun Nov  6 08:49:37 1994"). Checked before Date.parse(),
 * which also reads "-5", "+5" or "1.5" as dates (in 2001, so "retry now").
 */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const RFC_850_DATE = /^[A-Z][a-z]+day, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * Seconds to wait from a Retry-After header: delta-seconds (digits only) or
 * an HTTP date. Undefined if there is none or it is anything else ("-5",
 * "1.5", "1e3"), so the caller's own backoff applies.
 */
function retryAfterSeconds(res: Response): number | undefined {
  const value = res.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  let at: number;
  if (IMF_FIXDATE.test(value) || RFC_850_DATE.test(value)) at = Date.parse(value);
  // asctime carries no zone but means GMT; Date.parse() would take local time.
  else if (ASCTIME_DATE.test(value)) at = Date.parse(`${value} GMT`);
  else return undefined;
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * The server refuses every token from this address for a while after too many
 * wrong ones (429). Seconds to wait come from Retry-After, or the error text.
 */
function tooManyAttempts(seconds: number): string {
  return `Too many wrong upload tokens were tried from this address. Try again ${waitText(seconds)}.`;
}

/** The most of one unit waitText() says before it uses the next ("90 minutes", then "2 hours"). */
const MAX_IN_UNIT = 90;

/**
 * When to try again, for a message: "in 45 seconds", "in 15 minutes", "in 3
 * hours", or "later" for no wait known or one over a day (a server may send
 * any Retry-After, 100000000000000000000 included). The count is rounded up
 * and given in the smallest unit that keeps it at most MAX_IN_UNIT: so at
 * most two digits, 90 seconds or 2 minutes, 90 minutes or 2 hours.
 */
function waitText(seconds: number): string {
  const unit = (n: number, name: string) => `in ${n} ${name}${n === 1 ? "" : "s"}`;
  if (!(seconds > 0) || seconds > 86_400) return "later";
  const whole = Math.ceil(seconds);
  if (whole <= MAX_IN_UNIT) return unit(whole, "second");
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= MAX_IN_UNIT) return unit(minutes, "minute");
  return unit(Math.ceil(seconds / 3600), "hour");
}

/** Call the server API and parse the JSON response, with readable errors. */
export async function api<T>(
  config: Config,
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.url}/api${path}`, {
      method,
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : init.body,
    });
  } catch (err) {
    if (init.signal?.aborted) throw init.signal.reason;
    const cause =
      err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    throw new ApiError(`Could not reach ${config.url}${cause}`, 0);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error;
    const retryAfter = retryAfterSeconds(res);
    // `yeet login` words these two without the advice to run itself (see login()).
    if (res.status === 401) {
      throw new ApiError("The server rejected the upload token. Run `yeet login` again.", 401);
    }
    if (res.status === 429) {
      const seconds = retryAfter || Number(message?.match(/(\d+)\s*s\b/)?.[1]) || 0;
      const tooMany = tooManyAttempts(seconds);
      throw new ApiError(
        `${tooMany} If your token is wrong, run \`yeet login\` again after that.`,
        429,
        tooMany,
        seconds || undefined,
      );
    }
    if (res.status === 404 && message === undefined) {
      throw new ApiError(`${config.url} does not look like a yeet server (404 on ${path})`, 404);
    }
    throw new ApiError(
      message ?? `Server returned ${res.status}`,
      res.status,
      undefined,
      retryAfter,
    );
  }
  return data as T;
}

/**
 * The longest Retry-After withRetries() waits for. A server that asks for
 * longer (e.g. 429 after too many wrong tokens, for up to a minute or more)
 * gets no retry: the error says when to try again instead.
 */
const MAX_RETRY_AFTER_S = 10;

/**
 * Retry transient failures (network errors, 5xx and 429) with backoff (1, 2
 * and 4 s), or after the server's Retry-After if it sent one, unless that is
 * longer than MAX_RETRY_AFTER_S. Once `signal` is aborted it stops: no
 * further attempt, and the signal's reason is thrown.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  tries = 4,
  signal?: AbortSignal,
): Promise<T> {
  for (let i = 1; ; i++) {
    signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (err) {
      signal?.throwIfAborted();
      const status = err instanceof ApiError ? err.status : 0;
      const transient = status === 0 || status >= 500 || status === 429;
      if (!transient || i >= tries) throw err;
      const retryAfter = err instanceof ApiError ? err.retryAfter : undefined;
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
        // Say when to try again (a 429's message already does).
        if (!(err instanceof ApiError) || status === 429) throw err;
        throw new ApiError(
          `${err.message.replace(/\.$/, "")}. Try again ${waitText(retryAfter)}.`,
          status,
          err.forLogin,
          retryAfter,
        );
      }
      await sleep(retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** (i - 1), signal);
    }
  }
}
