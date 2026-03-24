import type { LinkCompletionMethod, LinkFlow } from "./types/index";

export interface LinkCompletionEnvelope {
  sessionId: string;
  serviceId?: string;
  serviceDomain?: string;
  accountId?: string;
  bindingId?: string;
  flow?: LinkFlow;
  method?: LinkCompletionMethod;
  nonce?: string;
  returnUrl?: string;
  code?: string;
  nonceUrl?: string;
  verifyUrl?: string;
  statusUrl?: string;
  pendingRequestsUrl?: string;
}

function encodeParam(value: string): string {
  return encodeURIComponent(value);
}

function decodeParam(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, "%20"));
}

function parsePairs(rawPairs: string, map: Map<string, string>) {
  if (!rawPairs) return;
  for (const pair of rawPairs.split("&")) {
    if (!pair) continue;

    const [rawKey, ...rest] = pair.split("=");
    const rawValue = rest.join("=");
    const key = decodeParam(rawKey);
    const value = decodeParam(rawValue ?? "");

    if (!key) continue;
    map.set(key, value);
  }
}

function collectQuerySources(rawUrl: string): string[] {
  const queryStart = rawUrl.indexOf("?");
  const hashStart = rawUrl.indexOf("#");

  const sources: string[] = [];

  if (queryStart !== -1) {
    const query = hashStart === -1
      ? rawUrl.slice(queryStart + 1)
      : rawUrl.slice(queryStart + 1, hashStart);
    sources.push(query);
  }

  if (hashStart !== -1) {
    const fragment = rawUrl.slice(hashStart + 1);
    if (!fragment) {
      return sources;
    }

    const nestedQueryStart = fragment.indexOf("?");
    const fragmentQuery = nestedQueryStart === -1 ? fragment : fragment.slice(nestedQueryStart + 1);
    sources.push(fragmentQuery);
  }

  return sources;
}

function parseUrlToMap(rawUrl: string): Map<string, string> {
  const search = new Map<string, string>();
  const sources = collectQuerySources(rawUrl);

  for (const source of sources) {
    parsePairs(source, search);
  }

  if (!search.has("session_id") && rawUrl.includes("%3F")) {
    try {
      const decoded = decodeURIComponent(rawUrl);
      for (const source of collectQuerySources(decoded)) {
        parsePairs(source, search);
      }
    } catch {
      // ignore malformed escapes and keep the best-effort raw parse
    }
  }

  return search;
}

function splitBaseUrl(baseUrl: string): { prefix: string; path: string } {
  const match = baseUrl.match(/^(presence:\/\/)(.*)$/);
  if (match) {
    return { prefix: match[1], path: match[2] || "link" };
  }
  const [path] = baseUrl.split("?");
  return { prefix: "", path };
}

export function buildPresenceLinkUrl(envelope: LinkCompletionEnvelope, baseUrl = "presence://link"): string {
  const params: Array<[string, string]> = [["s", envelope.sessionId]];
  const query = params.map(([k, v]) => `${encodeParam(k)}=${encodeParam(v)}`).join("&");
  const { prefix, path } = splitBaseUrl(baseUrl);
  const root = `${prefix}${path}`;
  return `${root}?${query}`;
}

export function parsePresenceLinkUrl(rawUrl: string): LinkCompletionEnvelope | null {
  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    const search = parseUrlToMap(trimmed);
    const sessionId = search.get("s") || search.get("session_id");
    if (!sessionId) return null;

    const serviceDomain = search.get("service_domain") ?? undefined;
    return {
      sessionId,
      serviceId: search.get("service_id") ?? undefined,
      serviceDomain,
      accountId: search.get("account_id") ?? undefined,
      bindingId: search.get("binding_id") ?? undefined,
      flow: (search.get("flow") as LinkFlow | undefined) ?? undefined,
      method: (search.get("method") as LinkCompletionMethod | undefined) ?? undefined,
      nonce: search.get("nonce") ?? undefined,
      returnUrl: search.get("return_url") ?? undefined,
      code: search.get("code") ?? undefined,
      nonceUrl: search.get("nonce_url") ?? undefined,
      verifyUrl: search.get("verify_url") ?? undefined,
      statusUrl: search.get("status_url") ?? undefined,
      pendingRequestsUrl: search.get("pending_url") ?? undefined,
    };
  } catch {
    return null;
  }
}
