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
}

function encodeParam(value: string): string {
  return encodeURIComponent(value);
}

function decodeParam(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, "%20"));
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
  const params: Array<[string, string]> = [["session_id", envelope.sessionId]];
  if (envelope.serviceId) params.push(["service_id", envelope.serviceId]);
  if (envelope.serviceDomain) params.push(["service_domain", envelope.serviceDomain]);
  if (envelope.accountId) params.push(["account_id", envelope.accountId]);
  if (envelope.bindingId) params.push(["binding_id", envelope.bindingId]);
  if (envelope.flow) params.push(["flow", envelope.flow]);
  if (envelope.method) params.push(["method", envelope.method]);
  if (envelope.nonce) params.push(["nonce", envelope.nonce]);
  if (envelope.returnUrl) params.push(["return_url", envelope.returnUrl]);
  if (envelope.code) params.push(["code", envelope.code]);
  if (envelope.nonceUrl) params.push(["nonce_url", envelope.nonceUrl]);
  if (envelope.verifyUrl) params.push(["verify_url", envelope.verifyUrl]);
  if (envelope.statusUrl) params.push(["status_url", envelope.statusUrl]);

  const query = params.map(([k, v]) => `${encodeParam(k)}=${encodeParam(v)}`).join("&");
  const { prefix, path } = splitBaseUrl(baseUrl);
  const root = `${prefix}${path}`;
  return query ? `${root}?${query}` : root;
}

export function parsePresenceLinkUrl(rawUrl: string): LinkCompletionEnvelope | null {
  try {
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    const queryIndex = trimmed.indexOf("?");
    if (queryIndex === -1) return null;

    const query = trimmed.slice(queryIndex + 1);
    const search = new Map<string, string>();

    for (const pair of query.split("&")) {
      if (!pair) continue;
      const [rawKey, ...rest] = pair.split("=");
      const rawValue = rest.join("=");
      search.set(decodeParam(rawKey), decodeParam(rawValue ?? ""));
    }

    const sessionId = search.get("session_id");
    if (!sessionId) return null;

    return {
      sessionId,
      serviceId: search.get("service_id") ?? undefined,
      serviceDomain: search.get("service_domain") ?? undefined,
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
    };
  } catch {
    return null;
  }
}
