/**
 * Storage probing: list buckets, then probe anonymous object listing per
 * bucket. Read-only GET requests only. Note: real Supabase object listing
 * is a POST endpoint, so a GET probe may return 405 there; the bucket list
 * itself is a GET and always works. A 403/404/405 on the object list is
 * treated as "not listable", never as an error.
 */
import { fetchWithTimeout } from "./http.js";

export interface BucketProbe {
  name: string;
  listable: boolean;
}

export type FetchFn = typeof fetchWithTimeout;

function anonHeaders(anonKey: string): Record<string, string> {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

/** GET /storage/v1/bucket - returns bucket names, or [] when not readable. */
export async function listBuckets(
  projectUrl: string,
  anonKey: string,
  fetchFn: FetchFn = fetchWithTimeout,
): Promise<string[]> {
  const url = `${projectUrl.replace(/\/$/, "")}/storage/v1/bucket`;
  let res;
  try {
    res = await fetchFn(url, { method: "GET", headers: anonHeaders(anonKey) });
  } catch {
    return [];
  }
  if (res.status !== 200) return [];
  try {
    const parsed: unknown = JSON.parse(res.text);
    if (!Array.isArray(parsed)) return [];
    const names: string[] = [];
    for (const item of parsed) {
      if (
        item !== null &&
        typeof item === "object" &&
        "name" in item &&
        typeof (item as Record<string, unknown>).name === "string"
      ) {
        names.push((item as Record<string, string>).name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Probe one bucket for anonymous object listing.
 * GET /storage/v1/object/list/<bucket>?limit=1 - a 200 with a non-empty
 * array means an anonymous visitor can list objects.
 */
export async function probeBucket(
  projectUrl: string,
  bucket: string,
  anonKey: string,
  fetchFn: FetchFn = fetchWithTimeout,
): Promise<BucketProbe> {
  const url = `${projectUrl.replace(/\/$/, "")}/storage/v1/object/list/${encodeURIComponent(bucket)}?limit=1`;
  let res;
  try {
    res = await fetchFn(url, { method: "GET", headers: anonHeaders(anonKey) });
  } catch {
    return { name: bucket, listable: false };
  }
  if (res.status !== 200) return { name: bucket, listable: false };
  try {
    const parsed: unknown = JSON.parse(res.text);
    return {
      name: bucket,
      listable: Array.isArray(parsed) && parsed.length > 0,
    };
  } catch {
    return { name: bucket, listable: false };
  }
}

/** List buckets and probe each one (at most one request per bucket). */
export async function probeStorage(
  projectUrl: string,
  anonKey: string,
  fetchFn: FetchFn = fetchWithTimeout,
): Promise<BucketProbe[]> {
  const names = await listBuckets(projectUrl, anonKey, fetchFn);
  const out: BucketProbe[] = [];
  for (const name of names) {
    out.push(await probeBucket(projectUrl, name, anonKey, fetchFn));
  }
  return out;
}
