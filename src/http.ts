/**
 * Minimal HTTP helpers. Read-only by construction: only GET and HEAD are
 * ever issued by this module, with a 10 second timeout per request.
 */

export type HttpMethod = "GET" | "HEAD";

export interface HttpResult {
  status: number;
  text: string;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  url: string,
  options: {
    method?: HttpMethod;
    headers?: Record<string, string>;
    timeoutMs?: number;
    redirect?: RequestRedirect;
  } = {},
): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    redirect: options.redirect ?? "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

/**
 * Fetch a URL following at most `maxRedirects` redirects (default 3).
 * Returns the final response body plus the final URL, or throws on
 * timeout / network failure / too many redirects.
 */
export async function fetchFollowingRedirects(
  url: string,
  maxRedirects = 3,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ finalUrl: string; text: string; status: number }> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location === null || hop === maxRedirects) {
        throw new Error(
          location === null
            ? `redirect without Location from ${current}`
            : `too many redirects (>${maxRedirects}) fetching ${url}`,
        );
      }
      current = new URL(location, current).toString();
      continue;
    }
    const text = await res.text();
    return { finalUrl: current, text, status: res.status };
  }
  throw new Error(`too many redirects (>${maxRedirects}) fetching ${url}`);
}
