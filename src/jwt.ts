/**
 * JWT decoding and classification (payload only, no signature verification).
 * vibeleak never verifies a signature: it only reads the `role` claim to
 * decide whether a key is safe to send (anon) or must be refused
 * (service_role / authenticated) before any request leaves the machine.
 */

export type JwtRole = "anon" | "service_role" | "authenticated" | "unknown";

export interface DecodedJwt {
  role: JwtRole;
  rawRole: string | null;
  payload: Record<string, unknown> | null;
}

function base64UrlDecode(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    return Buffer.from(withPad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Decode the payload of a JWT. Returns null when the token is malformed. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const raw = base64UrlDecode(parts[1]);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Classify a JWT by its `role` claim. Non-JWT input classifies as unknown. */
export function classifyJwt(token: string): DecodedJwt {
  const payload = decodeJwtPayload(token);
  if (payload === null) {
    return { role: "unknown", rawRole: null, payload: null };
  }
  const rawRole = typeof payload.role === "string" ? payload.role : null;
  let role: JwtRole = "unknown";
  if (rawRole === "anon") role = "anon";
  else if (rawRole === "service_role") role = "service_role";
  else if (rawRole === "authenticated") role = "authenticated";
  return { role, rawRole, payload };
}

/** True when the string looks like a Supabase publishable key. */
export function isPublishableKey(value: string): boolean {
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(value);
}

/** True when the string looks like a Supabase secret key (never sendable). */
export function isSecretKey(value: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Validate a key the user wants us to probe with.
 * Returns null when the key is safe to use, otherwise a refusal reason.
 * A service_role or authenticated JWT is refused BEFORE any request.
 */
export function refuseKeyReason(key: string): string | null {
  if (isSecretKey(key)) {
    return "refused: sb_secret_ keys bypass all Row Level Security and must never be sent by this tool";
  }
  if (key.startsWith("eyJ")) {
    const decoded = classifyJwt(key);
    if (decoded.role === "service_role") {
      return "refused: service_role JWT bypasses all Row Level Security and must never be sent by this tool";
    }
    if (decoded.role === "authenticated") {
      return "refused: authenticated JWT acts as a signed-in user; vibeleak only probes as an anonymous visitor";
    }
    if (decoded.role === "unknown") {
      return 'refused: JWT role claim is missing or unreadable; only role "anon" keys are accepted';
    }
    return null;
  }
  if (isPublishableKey(key)) return null;
  return "refused: key is neither an anon JWT nor a sb_publishable_ key";
}
