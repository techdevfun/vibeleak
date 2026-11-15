/**
 * Extraction of Supabase project URLs and keys from shipped frontend text.
 * Everything extracted here is already visible to any browser visitor:
 * the tool only reads what the deployed app itself ships.
 */
import { classifyJwt } from "./jwt.js";

export interface ExtractedSecrets {
  projectUrl: string | null;
  anonKey: string | null;
  publishableKey: string | null;
  /** A service_role JWT or sb_secret_ key was found in shipped code. */
  adminSecretFound: boolean;
  /** Roles seen across the JWTs found (for diagnostics only). */
  jwtRoles: string[];
}

const SUPABASE_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.supabase\.co/g;
const LOCAL_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const PUBLISHABLE_RE = /sb_publishable_[A-Za-z0-9_-]+/g;
const SECRET_RE = /sb_secret_[A-Za-z0-9_-]+/g;

/** Extract the Supabase project URL from text, if any. Prefers .supabase.co. */
export function extractProjectUrl(text: string): string | null {
  const hosted = text.match(SUPABASE_URL_RE);
  if (hosted && hosted.length > 0) return hosted[0];
  const local = text.match(LOCAL_URL_RE);
  if (local && local.length > 0) return local[0];
  return null;
}

/** Extract keys and secrets from one or more shipped text sources. */
export function extractSecrets(sources: string[]): ExtractedSecrets {
  const out: ExtractedSecrets = {
    projectUrl: null,
    anonKey: null,
    publishableKey: null,
    adminSecretFound: false,
    jwtRoles: [],
  };
  for (const text of sources) {
    if (out.projectUrl === null) {
      out.projectUrl = extractProjectUrl(text);
    }
    const secretHits = text.match(SECRET_RE);
    if (secretHits && secretHits.length > 0) out.adminSecretFound = true;
    const publishableHits = text.match(PUBLISHABLE_RE);
    if (publishableHits && publishableHits.length > 0 && out.publishableKey === null) {
      out.publishableKey = publishableHits[0];
    }
    const jwtHits = text.match(JWT_RE) ?? [];
    for (const jwt of jwtHits) {
      const decoded = classifyJwt(jwt);
      if (decoded.rawRole !== null && !out.jwtRoles.includes(decoded.rawRole)) {
        out.jwtRoles.push(decoded.rawRole);
      }
      if (decoded.role === "service_role") {
        out.adminSecretFound = true;
      }
      if (decoded.role === "anon" && out.anonKey === null) {
        out.anonKey = jwt;
      }
    }
  }
  return out;
}
