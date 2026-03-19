import type { LinkCompletionEnvelope } from "./deeplink";
import type { PresenceBindingSync, Result } from "./types/index";
import { err, ok } from "./types/index";

/**
 * First-pass trust model for session-provided sync URLs:
 * - fetch `https://{serviceDomain}/.well-known/presence.json`
 * - require the advertised `service_id` to match the session/service payload
 * - require `nonce_url` / `verify_url` to fall under an allowed prefix
 *
 * The cache is intentionally in-memory only so trust metadata expires on app restart.
 */

interface PresenceWellKnownDocument {
  version: string;
  service_id: string;
  allowed_url_prefixes: string[];
  [key: string]: unknown;
}

interface CachedPresenceWellKnown {
  cachedAtMs: number;
  document: PresenceWellKnownDocument;
}

const WELL_KNOWN_CACHE_TTL_MS = 15 * 60 * 1000;
const WELL_KNOWN_FETCH_TIMEOUT_MS = 10_000;
const wellKnownCache = new Map<string, CachedPresenceWellKnown>();

const DEMO_SERVICE_DOMAIN = "demo.presence.local";
const DEMO_WELL_KNOWN: PresenceWellKnownDocument = {
  version: "1",
  service_id: "presence-demo",
  allowed_url_prefixes: [
    "https://demo.presence.local/presence/nonce",
    "https://demo.presence.local/presence/verify",
  ],
};

export async function validateLinkCompletionEnvelope(envelope: LinkCompletionEnvelope): Promise<Result<void>> {
  return validateServiceSyncTargets({
    serviceId: envelope.serviceId,
    serviceDomain: envelope.serviceDomain,
    nonceUrl: envelope.nonceUrl,
    verifyUrl: envelope.verifyUrl,
  });
}

export function debugNormalizeServiceDomain(value?: string): string | null {
  return normalizeServiceDomain(value);
}

function explainServiceDomain(value?: string): { raw: string | null; normalized: string | null; reason: string } {
  if (value == null) return { raw: null, normalized: null, reason: "missing" };
  const raw = String(value);
  const trimmed = raw.trim();
  if (!trimmed) return { raw, normalized: null, reason: "empty" };
  if (/^https?:\/\//i.test(trimmed)) return { raw, normalized: null, reason: "must_not_include_scheme" };

  try {
    const parsed = new URL(`https://${trimmed}`);
    if (parsed.pathname !== "/") return { raw, normalized: null, reason: `must_not_include_path:${parsed.pathname}` };
    if (parsed.search) return { raw, normalized: null, reason: "must_not_include_query" };
    if (parsed.hash) return { raw, normalized: null, reason: "must_not_include_hash" };
    if (parsed.username || parsed.password) return { raw, normalized: null, reason: "must_not_include_userinfo" };
    return { raw, normalized: parsed.host.toLowerCase(), reason: "ok" };
  } catch {
    return { raw, normalized: null, reason: "invalid_host" };
  }
}

export async function validateBindingSyncConfiguration(params: {
  serviceId: string;
  sync?: PresenceBindingSync | null;
}): Promise<Result<void>> {
  return validateServiceSyncTargets({
    serviceId: params.serviceId,
    serviceDomain: params.sync?.serviceDomain,
    nonceUrl: params.sync?.nonceUrl,
    verifyUrl: params.sync?.verifyUrl,
  });
}

async function validateServiceSyncTargets(params: {
  serviceId?: string;
  serviceDomain?: string;
  nonceUrl?: string;
  verifyUrl?: string;
}): Promise<Result<void>> {
  const syncTargets = [
    ["nonce_url", params.nonceUrl],
    ["verify_url", params.verifyUrl],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);

  if (syncTargets.length === 0) {
    return ok(undefined);
  }

  const serviceId = params.serviceId?.trim();
  if (!serviceId) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      "This link includes service sync URLs but is missing service_id. Open a newer Presence link from the service."
    );
  }

  const serviceDomainDebug = explainServiceDomain(params.serviceDomain);
  if (!serviceDomainDebug.normalized) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `This link includes service sync URLs for ${serviceId} but service_domain is invalid (${serviceDomainDebug.reason}; raw=${JSON.stringify(serviceDomainDebug.raw)}).`
    );
  }
  const serviceDomain = serviceDomainDebug.normalized;

  const wellKnown = await loadPresenceWellKnown({ serviceDomain, serviceId });
  if (!wellKnown.ok) {
    return wellKnown;
  }

  const allowedPrefixes = normalizeAllowedPrefixes(wellKnown.value.allowed_url_prefixes);
  if (allowedPrefixes.length === 0) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `The Presence metadata for ${serviceDomain} does not allow any sync URL prefixes.`
    );
  }

  for (const [label, rawUrl] of syncTargets) {
    const absoluteUrl = normalizeAbsoluteUrl(rawUrl);
    if (!absoluteUrl) {
      return err(
        "ERR_SERVICE_TRUST_INVALID",
        `${label} is not a valid absolute URL in the Presence link for ${serviceId}.`
      );
    }

    if (!allowedPrefixes.some((prefix) => matchesAllowedPrefix(absoluteUrl, prefix))) {
      return err(
        "ERR_SERVICE_TRUST_INVALID",
        `${label} is outside the allowed Presence URL scope for ${serviceId} on ${serviceDomain}.`
      );
    }
  }

  return ok(undefined);
}

async function loadPresenceWellKnown(params: {
  serviceDomain: string;
  serviceId: string;
}): Promise<Result<PresenceWellKnownDocument>> {
  const cacheKey = `${params.serviceDomain}|${params.serviceId}`;
  const now = Date.now();
  const cached = wellKnownCache.get(cacheKey);

  if (cached && now - cached.cachedAtMs < WELL_KNOWN_CACHE_TTL_MS) {
    return ok(cached.document);
  }

  const builtInDocument = getBuiltInWellKnown(params.serviceDomain);
  if (builtInDocument) {
    const validation = validateWellKnownDocument(builtInDocument, params);
    if (!validation.ok) return validation;
    wellKnownCache.set(cacheKey, { cachedAtMs: now, document: validation.value });
    return validation;
  }

  const wellKnownUrl = `https://${params.serviceDomain}/.well-known/presence.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WELL_KNOWN_FETCH_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(wellKnownUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (cause) {
    const message = cause instanceof Error && cause.name === "AbortError"
      ? `Presence metadata fetch timed out after ${WELL_KNOWN_FETCH_TIMEOUT_MS}ms for ${params.serviceDomain}.`
      : `Couldn't fetch Presence metadata from ${wellKnownUrl}. Try again or request a new link from ${params.serviceId}.`;
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      message,
      cause
    );
  } finally {
    clearTimeout(timeout);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata fetch failed for ${params.serviceDomain} with HTTP ${response.status}.`,
      rawBody
    );
  }

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch (cause) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata from ${params.serviceDomain} is not valid JSON.`,
      cause
    );
  }

  const validation = validateWellKnownDocument(parsed, params);
  if (!validation.ok) return validation;

  wellKnownCache.set(cacheKey, {
    cachedAtMs: now,
    document: validation.value,
  });

  return validation;
}

function validateWellKnownDocument(
  document: unknown,
  params: { serviceDomain: string; serviceId: string }
): Result<PresenceWellKnownDocument> {
  if (!document || typeof document !== "object") {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata from ${params.serviceDomain} must be a JSON object.`
    );
  }

  const candidate = document as Partial<PresenceWellKnownDocument>;
  if (typeof candidate.version !== "string" || !candidate.version.trim()) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata from ${params.serviceDomain} is missing a valid version field.`
    );
  }

  if (typeof candidate.service_id !== "string" || !candidate.service_id.trim()) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata from ${params.serviceDomain} is missing a valid service_id field.`
    );
  }

  if (candidate.service_id !== params.serviceId) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata mismatch: expected service_id ${params.serviceId} but ${params.serviceDomain} published ${candidate.service_id}.`
    );
  }

  if (!Array.isArray(candidate.allowed_url_prefixes) || candidate.allowed_url_prefixes.some((value) => typeof value !== "string")) {
    return err(
      "ERR_SERVICE_TRUST_INVALID",
      `Presence metadata from ${params.serviceDomain} must include allowed_url_prefixes as a string array.`
    );
  }

  return ok(candidate as PresenceWellKnownDocument);
}

function getBuiltInWellKnown(serviceDomain: string): PresenceWellKnownDocument | null {
  return serviceDomain === DEMO_SERVICE_DOMAIN ? DEMO_WELL_KNOWN : null;
}

function normalizeServiceDomain(value?: string): string | null {
  return explainServiceDomain(value).normalized;
}

function normalizeAllowedPrefixes(prefixes: string[]): string[] {
  return prefixes
    .map((prefix) => normalizeAbsoluteUrl(prefix))
    .filter((prefix): prefix is string => !!prefix);
}

function matchesAllowedPrefix(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) return false;
  if (url.length === prefix.length) return true;

  const boundary = url.charAt(prefix.length);
  return boundary === "/" || boundary === "?" || boundary === "#";
}

function normalizeAbsoluteUrl(value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}
