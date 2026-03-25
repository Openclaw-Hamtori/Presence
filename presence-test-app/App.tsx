import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  AppStateStatus,
  SafeAreaView,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  ActivityIndicator,
  Platform,
  TextInput,
  Image,
  Modal,
  LogBox,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  Linking,
} from "react-native";
import { usePresenceState } from "./src/ui/usePresenceState";
import {
  addPushNotificationListener,
  consumeInitialPushNotificationResponse,
  ensurePushNotificationsRegistered,
  extractPendingProofWakeSignal,
  type PresencePendingProofWakeSignal,
  type PresencePushTokenRegistration,
} from "./src/pushNotifications";
import {
  createEmptyPushSetupState,
  getLatestPushToken,
  isPushUploadConfirmed,
  loadPushSetupState,
  notePushAuthorizationStatus,
  notePushTokenReceived,
  notePushUploadAttempt,
  notePushUploadConfirmed,
  notePushUploadConfirmationCleared,
  pushRegistrationSignature,
  savePushSetupState,
  type PresencePushSetupState,
} from "./src/pushRegistrationState";
import {
  loadPresenceState,
  savePresenceState,
  addOrUpdateServiceBinding,
  getActivePendingProofRequests,
  mergeAuthoritativeServiceBindings,
  isActiveBinding,
  hasRequiredBindingSyncMetadata,
  mergeBindingSyncMetadata,
  normalizeBindingSyncMetadata,
  suppressShadowedLegacyUnsyncableBindings,
} from "./src/state/presenceState";
import { buildPresenceLinkUrl, parsePresenceLinkUrl } from "./src/deeplink";
import type { LinkCompletionEnvelope } from "./src/deeplink";
import { debugNormalizeServiceDomain, validateLinkCompletionEnvelope } from "./src/linkTrust";
import type { PendingProofRequest, ServiceBinding } from "./src/types/index";
import type { ProveOptions } from "./src/service";
import { isQrScannerSupported, scanQrCode } from "./src/qrScanner";
import { getInitialPresenceLink, subscribeToPresenceLinks } from "./src/ui/connectionLinking";
import {
  submitLinkedBindingProof,
} from "./src/sync/linkedBindings";
import {
  syncPendingProofRequests,
  submitPendingProofRequest,
} from "./src/sync/pendingProofRequests";
import {
  hydrateBindingWithCanonicalSync,
  selectPendingProofRequestsForBindings,
} from "./src/sync/pendingProofHydration";
import {
  resolveRequestedLinkedBinding,
  syncFromEnvelope,
  shouldUseLinkedVerifyRoute,
  buildProveOptionsFromEnvelope,
  hydrateLinkCompletionEnvelopeFromSession,
  inferEnvelopeFlow,
} from "./src/sync/requestedBinding";
import {
  buildRequestedProofKey,
  getProductState,
  type RequestedProofUiStatus,
} from "./src/ui/productState";

const C = {
  bg: "#FFFFFF",
  panel: "#FFFFFF",
  surface: "#F7F7F4",
  surfaceSoft: "#FFFFFF",
  border: "#E7E3DA",
  accent: "#1B1B18",
  accentSoft: "#F0EEE7",
  text: "#1B1B18",
  subtext: "#8B887F",
  success: "#57B97A",
  warn: "#B07B1A",
  error: "#A94A4A",
  mono: "#5F5A50",
  qr: "#1B1B18",
} as const;

const ORB_IMAGE = require("./src/ui/assets/presence-orb.png");

const MONO_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";
const SYNC_LOG_CHUNK_SIZE = 4;
const MAX_LOG_ENTRIES = 240;
const RECENT_VERIFIED_PASS_HOLD_MS = 10_000;
const INITIAL_LINK_CONNECTED_HOLD_MS = 10_000;
const RECENT_PROOF_FAILURE_HOLD_MS = 10_000;
const PRESENCE_DEMO_API_BASE_URL = "https://noctu.link/presence-demo/presence";

type LinkedProofRequestState =
  | { requestKey: string; status: RequestedProofUiStatus }
  | null;
type RecentProofFailureState =
  | { requestKey: string; status: "failed" | "expired"; serviceId: string | null; expiresAt: number }
  | null;
type RecentVerifiedProofState =
  | { serviceId: string | null; expiresAt: number }
  | null;
type RecentConnectedLinkState =
  | { serviceId: string | null; expiresAt: number }
  | null;
type PendingPushWakeState = {
  signal: PresencePendingProofWakeSignal;
  source: string;
};

function nowTime(): string {
  return new Date().toISOString().slice(11, 19);
}

function colorForProductTone(tone: "success" | "warn" | "error"): string {
  if (tone === "success") return C.success;
  if (tone === "error") return C.error;
  return C.warn;
}

function truncateJson(obj: unknown, maxLen = 1400): string {
  const full = JSON.stringify(obj, null, 2);
  if (full.length <= maxLen) return full;
  return `${full.slice(0, maxLen)}\n  …(truncated)`;
}

function formatGroupedLogEntries(label: string, values: string[], chunkSize = SYNC_LOG_CHUNK_SIZE): string[] {
  if (values.length === 0) {
    return [`${label}[0/0] -`];
  }

  const lines: string[] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    const chunk = values.slice(index, index + chunkSize);
    lines.push(`${label}[${index + 1}-${index + chunk.length}/${values.length}] ${chunk.join(" | ")}`);
  }
  return lines;
}

function normalizeAbsoluteUrl(value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function buildCompletionUrl(envelope: LinkCompletionEnvelope | null): string | null {
  const statusUrl = normalizeAbsoluteUrl(envelope?.statusUrl);
  if (!statusUrl) return null;
  return statusUrl.endsWith("/complete")
    ? statusUrl
    : `${statusUrl.replace(/\/$/, "")}/complete`;
}

interface AuditEventRecord {
  type: string;
  serviceId: string;
  accountId: string;
  bindingId?: string;
  deviceIss?: string;
  occurredAt: number;
}

interface AuditEventsResponse {
  ok: true;
  events: AuditEventRecord[];
}

interface LinkedAccountStatusResponse {
  ok: true;
  readiness?: {
    checkedAt?: number;
    binding?: {
      bindingId?: string;
      serviceId?: string;
      accountId?: string;
      deviceIss?: string;
      createdAt?: number;
      updatedAt?: number;
      status?: string;
      lastLinkedAt?: number;
      lastVerifiedAt?: number;
    };
  };
}

interface DeviceBindingsResponse {
  ok: true;
  device?: {
    iss?: string;
    pushTokens?: Array<{
      token?: string;
      environment?: "development" | "production";
      bundleId?: string;
      status?: "active" | "invalidated";
      lastConfirmedAt?: number;
    }>;
  } | null;
  bindings: Array<{
    bindingId: string;
    serviceId: string;
    accountId: string;
    deviceIss: string;
    status: ServiceBinding["status"];
    createdAt?: number;
    updatedAt?: number;
    lastLinkedAt?: number;
    lastVerifiedAt?: number;
  }>;
}

interface CompletionBindingRecord {
  bindingId?: string;
  serviceId?: string;
  accountId?: string;
  deviceIss?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  lastLinkedAt?: number;
  lastVerifiedAt?: number;
}

const normalizeServiceBindingStatus = (status?: string): ServiceBinding["status"] => {
  switch (status?.trim().toLowerCase()) {
    case "linked":
      return "linked";
    case "unlinked":
    case "binding_unlinked":
      return "unlinked";
    case "revoked":
      return "revoked";
    case "reauth_required":
    case "reauth-required":
    case "reauth":
      return "reauth_required";
    case "recovery_pending":
    case "recovery-pending":
    case "pending_recovery":
      return "recovery_pending";
    default:
      return "unlinked";
  }
}

interface LinkSessionLookupResponse {
  ok: true;
  session: {
    id: string;
    serviceId: string;
    accountId: string;
    issuedNonce: string;
    status?: string;
    expiresAt?: number;
    relinkOfBindingId?: string;
    recoveryReason?: string;
    completion?: {
      method?: string;
      fallbackCode?: string;
      sessionStatusUrl?: string;
      linkedNonceApiUrl?: string;
      verifyLinkedAccountApiUrl?: string;
      pendingProofRequestsApiUrl?: string;
    };
  };
}

interface CompletionSuccessResponse {
  ok: true;
  state?: "linked";
  binding?: CompletionBindingRecord;
}

type SeedConfirmedBindingResult =
  | { ok: true; seeded: boolean }
  | { ok: false; message: string };

interface WellKnownPresenceDocument {
  service_id?: string;
  allowed_url_prefixes?: string[];
}

interface HydratedBindingCache {
  deviceIss: string;
  bindings: ServiceBinding[];
  isAuthoritative: boolean;
}

const WELL_KNOWN_PRESENCE_PATH = "/.well-known/presence.json";
const PRESENCE_LINK_SESSION_PATH = "/link-sessions";
const PRESENCE_LINK_SESSION_PATH_ALT = "/presence/link-sessions";
const serviceDomainApiBaseCache = new Map<string, string>();
type AddLogFn = (message: string) => void;
const noopAddLog: AddLogFn = () => {};

function normalizeServiceDomainHost(hostPort: string): string | null {
  const host = hostPort.includes(":") ? hostPort.slice(0, hostPort.indexOf(":")) : hostPort;
  const normalizedHost = host.toLowerCase();

  if (!normalizedHost || normalizedHost.startsWith(".") || normalizedHost.endsWith(".")) {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(normalizedHost) || !normalizedHost.includes(".")) {
    return null;
  }

  return normalizedHost.replace(/^www\./, "");
}

function parseAllowedPrefix(raw: string): {
  scheme: string;
  host: string;
  hostPort: string;
  path: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const parsed = trimmed.match(/^(?:(https?):\/\/)?([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i);
  if (!parsed || !parsed[2]) {
    return null;
  }

  const scheme = (parsed[1] ?? "https").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    return null;
  }

  const hostPort = parsed[2].toLowerCase();
  const host = normalizeServiceDomainHost(hostPort);
  if (!host) {
    return null;
  }

  const path = (parsed[3] ?? "").replace(/\/+$/g, "");
  return { scheme, host, hostPort, path };
}

function normalizeHttpsServiceOrigin(serviceDomain: string): string {
  const trimmed = serviceDomain.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Missing service_domain for canonical short-link hydration.");
  }

  const hostPort = trimmed.includes("://")
    ? trimmed.replace(/^https?:\/\//i, "")
    : trimmed;

  const host = normalizeServiceDomainHost(hostPort.split(/[/?#]/)[0]);
  if (!host) {
    throw new Error(`Invalid service domain for hydration: ${serviceDomain}`);
  }

  return host;
}

function pickAllowedPrefix(
  doc: WellKnownPresenceDocument,
  serviceDomain: string,
  addLog: AddLogFn = noopAddLog
): string | undefined {
  const normalizedServiceDomain = normalizeServiceDomainHost(serviceDomain) ?? "";

  if (!normalizedServiceDomain || !Array.isArray(doc?.allowed_url_prefixes) || doc.allowed_url_prefixes.length === 0) {
    return undefined;
  }

  for (const raw of doc.allowed_url_prefixes) {
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }

    const parsed = parseAllowedPrefix(raw);
    if (!parsed) {
      continue;
    }

    if (parsed.host !== normalizedServiceDomain) {
      continue;
    }

    const candidatePrefix = `${parsed.scheme}://${parsed.hostPort}${parsed.path}`;
    addLog(
      `[PresenceTestApp] Selected .well-known prefix for ${normalizedServiceDomain}: ${candidatePrefix}`
    );
    return candidatePrefix;
  }

  addLog(
    `[PresenceTestApp] No matching .well-known prefix for ${normalizedServiceDomain}: ` +
    `${JSON.stringify(doc?.allowed_url_prefixes ?? [])}`
  );
  return undefined;
}

async function resolvePresenceApiBaseFromServiceDomain(
  serviceDomain: string,
  addLog: AddLogFn = noopAddLog
): Promise<string> {
  const normalizedServiceDomain = normalizeHttpsServiceOrigin(serviceDomain);

  const cached = serviceDomainApiBaseCache.get(normalizedServiceDomain);
  if (cached) {
    return cached;
  }

  const discoveryUrl = `https://${normalizedServiceDomain}${WELL_KNOWN_PRESENCE_PATH}`;
  const document = await fetchJson<WellKnownPresenceDocument>(discoveryUrl);
  addLog(
    `[PresenceTestApp] fetched .well-known for ${normalizedServiceDomain}: keys=${JSON.stringify(
      Object.keys(document ?? {})
    )}`
  );
  addLog(
    `[PresenceTestApp] .well-known allowed_url_prefixes for ${normalizedServiceDomain}: ` +
    `${JSON.stringify(document?.allowed_url_prefixes ?? [])}`
  );

  const picked = pickAllowedPrefix(document, normalizedServiceDomain, addLog);
  if (!picked) {
    addLog(
      `[PresenceTestApp] .well-known candidate mismatch for ${normalizedServiceDomain}: ` +
      `${JSON.stringify(document?.allowed_url_prefixes ?? [])}`
    );
    throw new Error(`Unable to resolve API base from well-known for ${normalizedServiceDomain}`);
  }

  serviceDomainApiBaseCache.set(normalizedServiceDomain, picked);
  return picked;
}

function pickSessionLookupPath(baseUrl: string): string {
  if (baseUrl.endsWith("/presence")) {
    return PRESENCE_LINK_SESSION_PATH;
  }
  return PRESENCE_LINK_SESSION_PATH_ALT;
}

function resolveSessionLookupUrl(
  sessionId: string,
  serviceDomain: string,
  addLog: AddLogFn = noopAddLog
): Promise<string> {
  return resolvePresenceApiBaseFromServiceDomain(serviceDomain, addLog).then((baseUrl) => {
    const normalizedBase = baseUrl.replace(/\/+$/g, "");
    const lookupPath = pickSessionLookupPath(normalizedBase);
    return `${normalizedBase}${lookupPath}/${encodeURIComponent(sessionId)}`;
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const raw = await response.text();
  let parsed: { message?: string } | null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (error) {
    const preview = raw ? raw.trimStart().slice(0, 40) : "";
    const prefix = preview ? ` (${preview[0]}...)` : "";
    throw new Error(`Failed to parse JSON from ${url}${prefix}: ${error instanceof Error ? error.message : "parse error"}`);
  }
  if (!response.ok) {
    throw new Error(parsed?.message ?? `request failed (${response.status})`);
  }
  return parsed as T;
}

function bindingLogicalKeyOf(binding: Pick<ServiceBinding, "linkedDeviceIss" | "serviceId" | "accountId">): string {
  return `${binding.linkedDeviceIss}:${binding.serviceId}:${binding.accountId ?? "-"}`;
}

function describeBindingSync(sync: ServiceBinding["sync"] | undefined): string {
  const normalized = normalizeBindingSyncMetadata(sync);
  return [
    `sync=${normalized ? "present" : "missing"}`,
    `service_domain=${normalized?.serviceDomain ? "present" : "missing"}`,
    `nonce_url=${normalized?.nonceUrl ? "present" : "missing"}`,
    `verify_url=${normalized?.verifyUrl ? "present" : "missing"}`,
    `status_url=${normalized?.statusUrl ? "present" : "missing"}`,
    `pending_url=${normalized?.pendingRequestsUrl ? "present" : "missing"}`,
  ].join(" ");
}

function describePresenceValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().length > 0 ? "present" : "missing";
  }
  return value ? "present" : "missing";
}

function inferRequestedBindingResolution(
  envelope: LinkCompletionEnvelope | null,
  binding: ServiceBinding | null
): string {
  if (!envelope || !binding) return "none";
  if (envelope.bindingId && envelope.bindingId === binding.bindingId) return "binding_id";
  if (envelope.serviceId && envelope.accountId && envelope.serviceId === binding.serviceId && envelope.accountId === binding.accountId) {
    return "service_account";
  }
  return "fallback";
}

function buildPushTokenKey(registration: PresencePushTokenRegistration | null): string | null {
  if (!registration) return null;
  return [
    registration.token,
    registration.environment,
    registration.bundleId ?? "-",
  ].join(":");
}

function matchesActiveServerPushToken(
  registration: PresencePushTokenRegistration,
  candidate: NonNullable<NonNullable<DeviceBindingsResponse["device"]>["pushTokens"]>[number] | null | undefined
): boolean {
  if (!candidate || candidate.status !== "active") {
    return false;
  }

  const candidateToken = typeof candidate.token === "string"
    ? candidate.token.replace(/[^0-9a-f]/gi, "").toLowerCase()
    : null;
  const candidateBundleId = typeof candidate.bundleId === "string" && candidate.bundleId.trim().length > 0
    ? candidate.bundleId.trim()
    : undefined;

  return (
    candidateToken === registration.token
    && (candidate.environment === "production" ? "production" : "development") === registration.environment
    && candidateBundleId === registration.bundleId
  );
}

function findMatchingBinding(
  bindings: ServiceBinding[],
  candidate: Pick<ServiceBinding, "bindingId" | "linkedDeviceIss" | "serviceId" | "accountId">
): ServiceBinding | undefined {
  return bindings.find((binding) => binding.bindingId === candidate.bindingId)
    ?? bindings.find((binding) => bindingLogicalKeyOf(binding) === bindingLogicalKeyOf(candidate));
}

function mergeServiceBindings(bindings: ServiceBinding[]): ServiceBinding[] {
  const byKey = new Map<string, ServiceBinding>();

  const mergePair = (current: ServiceBinding, incoming: ServiceBinding): ServiceBinding => {
    const currentTime = current.lastVerifiedAt ?? current.linkedAt ?? 0;
    const incomingTime = incoming.lastVerifiedAt ?? incoming.linkedAt ?? 0;
    const newerWins = incomingTime >= currentTime;
    const preferred = newerWins ? { ...current, ...incoming } : { ...incoming, ...current };
    preferred.sync = newerWins
      ? mergeBindingSyncMetadata(current.sync, incoming.sync)
      : mergeBindingSyncMetadata(incoming.sync, current.sync);

    const currentLooksLocal = current.bindingId.startsWith("local_");
    const incomingLooksLocal = incoming.bindingId.startsWith("local_");
    if (currentLooksLocal && !incomingLooksLocal) {
      preferred.bindingId = incoming.bindingId;
    } else if (!currentLooksLocal && incomingLooksLocal) {
      preferred.bindingId = current.bindingId;
    }

    return preferred;
  };

  for (const binding of bindings) {
    const logicalKey = bindingLogicalKeyOf(binding);
    const existingLogical = byKey.get(logicalKey);
    if (existingLogical) {
      byKey.set(logicalKey, mergePair(existingLogical, binding));
      continue;
    }

    const idKey = `id:${binding.bindingId}`;
    const existingById = byKey.get(idKey);
    if (existingById) {
      const merged = mergePair(existingById, binding);
      byKey.delete(idKey);
      byKey.set(bindingLogicalKeyOf(merged), merged);
      continue;
    }

    byKey.set(logicalKey, binding);
  }

  return [...byKey.values()];
}

function preserveLocalBindingSyncMetadata(
  recoveredBindings: ServiceBinding[],
  localBindings: ServiceBinding[],
  deviceIss: string
): ServiceBinding[] {
  const localById = new Map<string, ServiceBinding>();
  const localByLogicalKey = new Map<string, ServiceBinding>();

  for (const binding of localBindings) {
    if (binding.linkedDeviceIss !== deviceIss) continue;
    localById.set(binding.bindingId, binding);
    localByLogicalKey.set(bindingLogicalKeyOf(binding), binding);
  }

  return recoveredBindings.map((binding) => {
    const existing = localById.get(binding.bindingId) ?? localByLogicalKey.get(bindingLogicalKeyOf(binding));
    if (!existing?.sync) {
      return binding;
    }

    return {
      ...binding,
      sync: mergeBindingSyncMetadata(existing.sync, binding.sync),
    };
  });
}

function toServiceBindingFromRecord(
  binding: CompletionBindingRecord | null | undefined,
  sync?: ServiceBinding["sync"]
): ServiceBinding | null {
  if (!binding?.bindingId || !binding.serviceId || !binding.accountId || !binding.deviceIss || !binding.status) {
    return null;
  }

  // Backend payloads use `deviceIss`; app-local state stores the same value as
  // `linkedDeviceIss` to distinguish the local binding view from the SDK model.
  return hydrateBindingWithCanonicalSync({
    bindingId: binding.bindingId,
    serviceId: binding.serviceId,
    accountId: binding.accountId,
    linkedDeviceIss: binding.deviceIss,
    linkedAt: binding.lastLinkedAt ?? binding.createdAt ?? binding.updatedAt ?? Math.floor(Date.now() / 1000),
    lastVerifiedAt: binding.lastVerifiedAt,
    status: normalizeServiceBindingStatus(binding.status),
    sync: normalizeBindingSyncMetadata(sync),
  }, PRESENCE_DEMO_API_BASE_URL);
}

function toServiceBindingFromStatus(response: LinkedAccountStatusResponse): ServiceBinding | null {
  const binding = toServiceBindingFromRecord(response.readiness?.binding, undefined);
  if (!binding) {
    return null;
  }

  return {
    ...binding,
    linkedAt: binding.linkedAt || response.readiness?.checkedAt || Math.floor(Date.now() / 1000),
  };
}

function isHealthAccessRecoveryNeeded(code?: string, message?: string | null): boolean {
  if (code === "ERR_HEALTHKIT_PERMISSION_DENIED") return true;
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return (
    text.includes("authorization not determined")
    || text.includes("not authorized")
    || text.includes("permission denied")
    || text.includes("health access")
    || text.includes("err_no_bpm_data")
  );
}


export default function App() {
  const presence = usePresenceState();
  const [rawLink, setRawLink] = useState("");
  const [openedEnvelope, setOpenedEnvelope] = useState<LinkCompletionEnvelope | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [hydratingLinkSession, setHydratingLinkSession] = useState(false);
  const [showService, setShowService] = useState(false);
  const [scannerSupported, setScannerSupported] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [submittingLinkedProof, setSubmittingLinkedProof] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [linkedProofRequestState, setLinkedProofRequestState] = useState<LinkedProofRequestState>(null);
  const [recentProofFailure, setRecentProofFailure] = useState<RecentProofFailureState>(null);
  const [recentVerifiedProof, setRecentVerifiedProof] = useState<RecentVerifiedProofState>(null);
  const [recentConnectedLink, setRecentConnectedLink] = useState<RecentConnectedLinkState>(null);
  const [logEntries, setLogEntries] = useState<string[]>([`[${nowTime()}] App started - platform: ${Platform.OS}`]);
  const [hydratedServiceBindings, setHydratedServiceBindings] = useState<HydratedBindingCache | null>(null);
  const [hydratingServiceBindings, setHydratingServiceBindings] = useState(false);
  const [serviceBindingsHydrationError, setServiceBindingsHydrationError] = useState<string | null>(null);
  const [syncingPendingRequests, setSyncingPendingRequests] = useState(false);
  const [pendingRequestsSyncError, setPendingRequestsSyncError] = useState<string | null>(null);
  const [pushSetupState, setPushSetupState] = useState<PresencePushSetupState>(createEmptyPushSetupState());
  const serviceScrollRef = useRef<ScrollView | null>(null);
  const [serviceViewportHeight, setServiceViewportHeight] = useState(0);
  const [serviceContentHeight, setServiceContentHeight] = useState(0);
  const [serviceScrollOffset, setServiceScrollOffset] = useState(0);
  const currentDeviceIss = presence.state?.linkedDevice?.iss;
  const currentDeviceIssRef = useRef<string | undefined>(currentDeviceIss);
  const pushSetupStateRef = useRef<PresencePushSetupState>(createEmptyPushSetupState());
  const effectiveServiceBindingsRef = useRef<ServiceBinding[]>([]);
  const pendingPushWakeRef = useRef<PendingPushWakeState | null>(null);
  const pendingLinkPushUploadDeviceIssRef = useRef<string | null>(null);
  const pushRegistrationInFlightSignatureRef = useRef<string | null>(null);
  const pushRegistrationAttemptedDevicesRef = useRef<Set<string>>(new Set());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const addLog = useCallback((msg: string) => {
    const line = `[${nowTime()}] ${msg}`;
    console.log(`[PresenceApp] ${line}`);
    setLogEntries((prev) => [line, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  const updatePushSetupState = useCallback(async (
    updater: (state: PresencePushSetupState) => PresencePushSetupState
  ): Promise<PresencePushSetupState> => {
    const next = updater(pushSetupStateRef.current);
    pushSetupStateRef.current = next;
    setPushSetupState(next);
    await savePushSetupState(next);
    return next;
  }, []);

  useEffect(() => {
    currentDeviceIssRef.current = currentDeviceIss;
  }, [currentDeviceIss]);

  useEffect(() => {
    let cancelled = false;

    void loadPushSetupState()
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        pushSetupStateRef.current = loaded;
        setPushSetupState(loaded);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!recentVerifiedProof) return;
    const remainingMs = recentVerifiedProof.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setRecentVerifiedProof(null);
      return;
    }
    const timeout = setTimeout(() => {
      setRecentVerifiedProof((current) => (
        current?.expiresAt === recentVerifiedProof.expiresAt ? null : current
      ));
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [recentVerifiedProof]);

  useEffect(() => {
    if (!recentConnectedLink) return;
    const remainingMs = recentConnectedLink.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setRecentConnectedLink(null);
      return;
    }
    const timeout = setTimeout(() => {
      setRecentConnectedLink((current) => (
        current?.expiresAt === recentConnectedLink.expiresAt ? null : current
      ));
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [recentConnectedLink]);

  useEffect(() => {
    if (!recentProofFailure) return;
    const remainingMs = recentProofFailure.expiresAt - Date.now();
    if (remainingMs <= 0) {
      setRecentProofFailure(null);
      return;
    }
    const timeout = setTimeout(() => {
      setRecentProofFailure((current) => (
        current?.expiresAt === recentProofFailure.expiresAt ? null : current
      ));
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [recentProofFailure]);

  const rememberRecentVerifiedProof = useCallback((serviceId?: string | null) => {
    setRecentVerifiedProof({
      serviceId: serviceId ?? null,
      expiresAt: Date.now() + RECENT_VERIFIED_PASS_HOLD_MS,
    });
  }, []);

  const rememberRecentConnectedLink = useCallback((serviceId?: string | null) => {
    setRecentConnectedLink({
      serviceId: serviceId ?? null,
      expiresAt: Date.now() + INITIAL_LINK_CONNECTED_HOLD_MS,
    });
  }, []);

  const rememberRecentProofFailure = useCallback((request: {
    requestKey: string;
    status: "failed" | "expired";
    serviceId?: string | null;
  }) => {
    setRecentProofFailure({
      requestKey: request.requestKey,
      status: request.status,
      serviceId: request.serviceId ?? null,
      expiresAt: Date.now() + RECENT_PROOF_FAILURE_HOLD_MS,
    });
  }, []);

  const clearRecentProofFailure = useCallback((requestKey: string | null) => {
    setRecentProofFailure((current) => (
      !current || current.requestKey !== requestKey
        ? current
        : null
    ));
  }, []);

  const runLocalMeasurement = useCallback(async () => {
    const measurement = await presence.measure();
    if (!measurement) {
      addLog("❌ Measurement failed");
      return null;
    }

    addLog(
      measurement.pass
        ? "✅ Local-only check passed - not server-verified"
        : `⚠️ Local-only check failed - ${measurement.reason}`
    );
    addLog(
      `   state: created=${measurement.state?.stateCreatedAt ?? '-'} validUntil=${measurement.state?.stateValidUntil ?? '-'} measured=${measurement.state?.lastMeasuredAt ?? '-'} phase=${measurement.state?.status ?? '-'}`
    );
    return measurement;
  }, [addLog, presence.measure]);

  const hydratedBindingsForCurrentDevice = useMemo(() => {
    if (!currentDeviceIss || hydratedServiceBindings?.deviceIss !== currentDeviceIss) {
      return [];
    }
    return hydratedServiceBindings.bindings;
  }, [currentDeviceIss, hydratedServiceBindings]);

  const localBindingsForHydration = useMemo(
    () => suppressShadowedLegacyUnsyncableBindings(
      mergeServiceBindings([...(presence.state?.serviceBindings ?? []), ...hydratedBindingsForCurrentDevice])
    ),
    [hydratedBindingsForCurrentDevice, presence.state?.serviceBindings]
  );
  const hasLinkedBindingForCurrentDevice = useMemo(
    () => !!currentDeviceIss && localBindingsForHydration.some((binding) => (
      binding.linkedDeviceIss === currentDeviceIss && isActiveBinding(binding)
    )),
    [currentDeviceIss, localBindingsForHydration]
  );
  const storedPushToken = useMemo(
    () => getLatestPushToken(pushSetupState),
    [pushSetupState]
  );
  const storedPushTokenKey = useMemo(
    () => buildPushTokenKey(storedPushToken),
    [storedPushToken]
  );
  const localBindingsForHydrationRef = useRef<ServiceBinding[]>(localBindingsForHydration);

  useEffect(() => {
    localBindingsForHydrationRef.current = localBindingsForHydration;
  }, [localBindingsForHydration]);

  const persistAuthoritativeBindings = useCallback(async (
    deviceIss: string,
    recoveredBindings: ServiceBinding[]
  ) => {
    const persisted = await loadPresenceState();
    if (persisted?.linkedDevice?.iss !== deviceIss) return;
    const mergedState = mergeAuthoritativeServiceBindings(persisted, recoveredBindings);
    if (JSON.stringify(mergedState.serviceBindings) === JSON.stringify(persisted.serviceBindings)) {
      return;
    }
    await savePresenceState(mergedState);
  }, []);

  const persistSeededBinding = useCallback(async (binding: ServiceBinding) => {
    const persisted = await loadPresenceState();
    if (persisted?.linkedDevice?.iss !== binding.linkedDeviceIss) return;
    const nextState = addOrUpdateServiceBinding(persisted, binding, {
      allowLinkedRecoveryExit: binding.status === "linked",
    });
    if (JSON.stringify(nextState.serviceBindings) === JSON.stringify(persisted.serviceBindings)) {
      return;
    }
    await savePresenceState(nextState);
  }, []);

  const seedConfirmedBinding = useCallback(async (
    response: CompletionSuccessResponse | null,
    envelope: LinkCompletionEnvelope | null
  ): Promise<SeedConfirmedBindingResult> => {
    const envelopeSync = syncFromEnvelope(envelope);
    addLog(
      `🔎 completion seed envelope session=${envelope?.sessionId ?? "-"} binding=${response?.binding?.bindingId ?? "-"} ${describeBindingSync(envelopeSync)}`
    );

    const confirmedBinding = toServiceBindingFromRecord(response?.binding, envelopeSync);
    if (!confirmedBinding) {
      addLog("ℹ️ completion seed skipped - response did not include a complete binding record");
      return { ok: true, seeded: false };
    }

    const existingBinding = findMatchingBinding(localBindingsForHydrationRef.current, confirmedBinding);
    const seededBinding: ServiceBinding = {
      ...existingBinding,
      ...confirmedBinding,
      bindingId: confirmedBinding.bindingId,
      sync: existingBinding
        ? mergeBindingSyncMetadata(existingBinding.sync, confirmedBinding.sync)
        : confirmedBinding.sync,
    };
    const existingHasRequiredSync = hasRequiredBindingSyncMetadata(existingBinding?.sync);
    const seededHasRequiredSync = hasRequiredBindingSyncMetadata(seededBinding.sync);
    const seedRequiresEnvelopeSync = !!envelopeSync && !existingHasRequiredSync;

    addLog(
      `🔎 completion seed boundary binding=${seededBinding.bindingId} require_envelope_sync=${seedRequiresEnvelopeSync ? "yes" : "no"}`
    );
    addLog(`   existing: ${describeBindingSync(existingBinding?.sync)}`);
    addLog(`   envelope: ${describeBindingSync(confirmedBinding.sync)}`);
    addLog(`   seeded: ${describeBindingSync(seededBinding.sync)}`);

    if (seedRequiresEnvelopeSync && !seededHasRequiredSync) {
      return {
        ok: false,
        message: "Server completion succeeded, but this link was missing sync metadata (nonce_url / verify_url), so the binding was not saved locally. Open a fresh Presence link from the service.",
      };
    }

    setHydratedServiceBindings((current) => {
      const currentBindings = current?.deviceIss === seededBinding.linkedDeviceIss ? current.bindings : [];
      return {
        deviceIss: seededBinding.linkedDeviceIss,
        bindings: mergeServiceBindings([seededBinding, ...currentBindings]),
        isAuthoritative: current?.deviceIss === seededBinding.linkedDeviceIss ? current.isAuthoritative : false,
      };
    });
    await persistSeededBinding(seededBinding);
    addLog(`✅ completion seed persisted - binding=${seededBinding.bindingId} ${describeBindingSync(seededBinding.sync)}`);
    return { ok: true, seeded: true };
  }, [addLog, persistSeededBinding]);

  const activateEnvelope = useCallback(async (
    parsed: LinkCompletionEnvelope,
    source: "link" | "qr" | "system",
    rawUrl?: string
  ): Promise<boolean> => {
    setRawLink(rawUrl ?? buildPresenceLinkUrl(parsed));
    setShowConnection(true);
    setLocalError(null);
    setLinkedProofRequestState(null);
    setRecentVerifiedProof(null);
    setHydratingLinkSession(true);

    let hydrated = parsed;
    if (!hydrated.nonce) {
      try {
        addLog("🔎 hydration lookup session=" + parsed.sessionId);
        const hydratedSessionLookup = await resolveSessionLookupUrl(parsed.sessionId, parsed.serviceDomain ?? "", addLog);
        const response = await fetchJson<LinkSessionLookupResponse>(hydratedSessionLookup);
        const hydration = hydrateLinkCompletionEnvelopeFromSession(response.session, parsed);
        if (!hydration.ok) {
          setOpenedEnvelope(null);
          setConnectionError(hydration.message);
          addLog(`❌ ${hydration.code} - ${hydration.message}`);
          return false;
        }
        hydrated = hydration.value;
        addLog("✅ hydration success session=" + (hydrated.sessionId ?? parsed.sessionId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setOpenedEnvelope(null);
        setConnectionError("Unable to load full link session details: " + message);
        addLog("❌ hydration failed for " + parsed.sessionId + " - " + message);
        return false;
      } finally {
        setHydratingLinkSession(false);
      }
    } else {
      setHydratingLinkSession(false);
    }

    const normalizedServiceDomain = debugNormalizeServiceDomain(hydrated.serviceDomain);
    const envelopeSync = syncFromEnvelope(hydrated);
    addLog(`🔎 ${source} parse session=${hydrated.sessionId} service=${hydrated.serviceId ?? "-"}`);
    addLog(
      `🔎 envelope boundary source=${source} flow=${hydrated.flow ?? (hydrated.bindingId ? "reauth" : "initial_link")} binding=${hydrated.bindingId ?? "-"} ${describeBindingSync(envelopeSync)}`
    );
    addLog(`🔎 service_domain raw=${JSON.stringify(hydrated.serviceDomain ?? null)} normalized=${JSON.stringify(normalizedServiceDomain)}`);
    addLog(`🔎 nonce_url=${hydrated.nonceUrl ?? "-"}`);
    addLog(`🔎 verify_url=${hydrated.verifyUrl ?? "-"}`);
    const trustValidation = await validateLinkCompletionEnvelope(hydrated);
    if (!trustValidation.ok) {
      setOpenedEnvelope(null);
      setConnectionError(trustValidation.error.message);
      addLog(`❌ ${trustValidation.error.code} - ${trustValidation.error.message}`);
      console.log(`[PresenceTestApp] ❌ ${trustValidation.error.code} - ${trustValidation.error.message}`);
      return false;
    }

    setConnectionError(null);
    setOpenedEnvelope(hydrated);
    addLog(`✅ trust validation passed for ${hydrated.serviceId ?? "unknown-service"} on ${normalizedServiceDomain ?? "unknown-domain"}`);
    addLog(`${source === "qr" ? "📷" : source === "system" ? "🔗" : "📲"} Opened ${source} session ${hydrated.sessionId}`);
    return true;
  }, [addLog]);


  useEffect(() => {
    LogBox.ignoreAllLogs();
    isQrScannerSupported().then(setScannerSupported).catch(() => setScannerSupported(false));

    getInitialPresenceLink().then((initialEnvelope) => {
      if (initialEnvelope) {
        void activateEnvelope(initialEnvelope, "system");
      }
    }).catch(() => undefined);

    return subscribeToPresenceLinks((envelope) => {
      void activateEnvelope(envelope, "system");
    });
  }, [activateEnvelope]);

  const hydrateAuthoritativeBindings = useCallback(async (deviceIss: string, source: string): Promise<ServiceBinding[]> => {
    setHydratingServiceBindings(true);
    setServiceBindingsHydrationError(null);
    try {
      const localBindings = localBindingsForHydrationRef.current;
      const deviceBindingsUrl = `${PRESENCE_DEMO_API_BASE_URL}/devices/${encodeURIComponent(deviceIss)}/bindings`;
      try {
        const deviceBindings = await fetchJson<DeviceBindingsResponse>(deviceBindingsUrl);
        const latestRegistration = getLatestPushToken(pushSetupStateRef.current);
        const matchingServerToken = latestRegistration
          ? deviceBindings.device?.pushTokens?.find((token) => matchesActiveServerPushToken(latestRegistration, token))
          : undefined;
        if (latestRegistration) {
          if (matchingServerToken) {
            const alreadyConfirmed = isPushUploadConfirmed(pushSetupStateRef.current, {
              deviceIss,
              registration: latestRegistration,
            });
            await updatePushSetupState((state) => notePushUploadConfirmed(state, {
              deviceIss,
              registration: latestRegistration,
              confirmedAt: matchingServerToken.lastConfirmedAt,
            }));
            if (!alreadyConfirmed) {
              addLog(`↻ confirmed APNs token from device record (${source})`);
            }
          } else if (isPushUploadConfirmed(pushSetupStateRef.current, {
            deviceIss,
            registration: latestRegistration,
          })) {
            await updatePushSetupState((state) => notePushUploadConfirmationCleared(state, {
              deviceIss,
              registration: latestRegistration,
            }));
            addLog(`↻ invalidated local APNs confirmation for ${deviceIss}: server has no matching active token (${source})`);
          }
        }
        const recoveredBindings = preserveLocalBindingSyncMetadata(
          deviceBindings.bindings
          .filter((binding) => binding.deviceIss === deviceIss)
          .map((binding) => hydrateBindingWithCanonicalSync({
            bindingId: binding.bindingId,
            serviceId: binding.serviceId,
            accountId: binding.accountId,
            linkedDeviceIss: binding.deviceIss,
            linkedAt: binding.lastLinkedAt ?? binding.createdAt ?? binding.updatedAt ?? Math.floor(Date.now() / 1000),
            lastVerifiedAt: binding.lastVerifiedAt,
            status: normalizeServiceBindingStatus(binding.status),
          }, PRESENCE_DEMO_API_BASE_URL)),
          localBindings,
          deviceIss
        );
        setHydratedServiceBindings({
          deviceIss,
          bindings: recoveredBindings,
          isAuthoritative: true,
        });
        await persistAuthoritativeBindings(deviceIss, recoveredBindings);
        addLog(`↻ Recovered ${recoveredBindings.length} bindings from device endpoint (${source})`);
        return recoveredBindings;
      } catch (deviceEndpointError) {
        addLog(`ℹ️ Device bindings endpoint unavailable (${source}) - ${deviceEndpointError instanceof Error ? deviceEndpointError.message : String(deviceEndpointError)} (GET ${deviceBindingsUrl})`);
      }

      const auditEventsUrl = `${PRESENCE_DEMO_API_BASE_URL}/audit-events`;
      const audit = await fetchJson<AuditEventsResponse>(auditEventsUrl);
      const recentAccounts = new Map<string, number>();
      for (const event of audit.events) {
        if (event.deviceIss !== deviceIss) continue;
        if (!["link_completed", "reauth_succeeded", "binding_relinked", "recovery_completed"].includes(event.type)) continue;
        const previous = recentAccounts.get(event.accountId) ?? 0;
        if (event.occurredAt > previous) recentAccounts.set(event.accountId, event.occurredAt);
      }

      const orderedAccountIds = [...recentAccounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([accountId]) => accountId);

      const recoveredBindings = preserveLocalBindingSyncMetadata(
        (
          await Promise.all(
            orderedAccountIds.map(async (accountId) => {
              try {
                const statusUrl = `${PRESENCE_DEMO_API_BASE_URL}/linked-accounts/${encodeURIComponent(accountId)}/status`;
                const status = await fetchJson<LinkedAccountStatusResponse>(statusUrl);
                const binding = toServiceBindingFromStatus(status);
                return binding?.linkedDeviceIss === deviceIss ? binding : null;
              } catch (statusError) {
                addLog(`ℹ️ skipping account status (${source}) ${accountId} - ${statusError instanceof Error ? statusError.message : String(statusError)}`);
                return null;
              }
            })
          )
        ).filter((binding): binding is ServiceBinding => !!binding),
        localBindings,
        deviceIss
      );

      setHydratedServiceBindings({
        deviceIss,
        bindings: recoveredBindings,
        isAuthoritative: true,
      });
      await persistAuthoritativeBindings(deviceIss, recoveredBindings);
      addLog(`↻ Recovered ${recoveredBindings.length} bindings via audit fallback (${source})`);
      return recoveredBindings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setServiceBindingsHydrationError(message);
      setHydratedServiceBindings({
        deviceIss,
        bindings: [],
        isAuthoritative: true,
      });
      await persistAuthoritativeBindings(deviceIss, []);
      addLog(`ℹ️ service auth sync failed for ${source}; showing no cached binding cards until next successful sync - ${message}`);
      return [];
    } finally {
      setHydratingServiceBindings(false);
    }
  }, [addLog, persistAuthoritativeBindings, updatePushSetupState]);

  const hydratePendingProofRequests = useCallback(async (bindings: ServiceBinding[], source: string) => {
    const currentState = await loadPresenceState();
    if (!currentState) {
      return;
    }

    setSyncingPendingRequests(true);
    setPendingRequestsSyncError(null);
    try {
      const result = await syncPendingProofRequests({
        state: currentState,
        bindings,
      });
      await presence.refresh();
      const activeCount = result.requests.filter((request) => request.status === "pending").length;
      addLog(`↻ Synced ${activeCount} pending proof requests (${source})`);
      for (const error of result.errors) {
        addLog(`ℹ️ pending request sync skipped for ${error.bindingId} - ${error.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingRequestsSyncError(message);
      addLog(`ℹ️ pending request sync failed (${source}) - ${message}`);
    } finally {
      setSyncingPendingRequests(false);
    }
  }, [addLog, presence.refresh]);

  const syncPushTokenWithServer = useCallback(async (
    registration: PresencePushTokenRegistration,
    source: string,
    options: { deviceIss?: string | null; requireLinkedBinding?: boolean } = {}
  ) => {
    const deviceIss = options.deviceIss ?? currentDeviceIssRef.current;
    if (!deviceIss) {
      addLog(`ℹ️ cached APNs token until a device id is available (${source})`);
      return;
    }

    const shouldRequireLinkedBinding = options.requireLinkedBinding !== false;
    if (shouldRequireLinkedBinding && !hasLinkedBindingForCurrentDevice) {
      addLog(`ℹ️ cached APNs token until a linked service is confirmed (${source})`);
      return;
    }

    addLog(`↪ syncPushTokenWithServer start (${source}) device=${deviceIss} env=${registration.environment}`);

    if (isPushUploadConfirmed(pushSetupStateRef.current, { deviceIss, registration })) {
      addLog(`ℹ️ skip push token sync for ${deviceIss}: already confirmed (${source})`);
      return;
    }

    const signature = pushRegistrationSignature({
      deviceIss,
      registration,
    });
    if (pushRegistrationInFlightSignatureRef.current === signature) {
      addLog(`ℹ️ skip push token sync for ${deviceIss}: upload already in flight (${source})`);
      return;
    }

    pushRegistrationInFlightSignatureRef.current = signature;
    await updatePushSetupState((state) => notePushUploadAttempt(state, {
      deviceIss,
      registration,
    }));

    try {
      const response = await fetch(
        `${PRESENCE_DEMO_API_BASE_URL}/devices/${encodeURIComponent(deviceIss)}/push-tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            token: registration.token,
            environment: registration.environment,
            bundleId: registration.bundleId,
          }),
        }
      );
      const raw = await response.text();
      const parsed = raw ? JSON.parse(raw) : null;
      if (!response.ok) {
        throw new Error(parsed?.message ?? `request failed (${response.status})`);
      }

      await updatePushSetupState((state) => notePushUploadConfirmed(state, {
        deviceIss,
        registration,
        confirmedAt: parsed?.pushToken?.lastConfirmedAt,
      }));
      addLog(
        `↻ registered APNs token for ${deviceIss} (${registration.environment}${registration.bundleId ? ` ${registration.bundleId}` : ""}) via ${source}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updatePushSetupState((state) => notePushUploadAttempt(state, {
        deviceIss,
        registration,
        error: message,
      }));
      throw error;
    } finally {
      pushRegistrationInFlightSignatureRef.current = null;
    }
  }, [addLog, hasLinkedBindingForCurrentDevice, updatePushSetupState]);

  const maybeSyncStoredPushToken = useCallback(async (source: string) => {
    const deviceIss = currentDeviceIssRef.current;
    const registration = getLatestPushToken(pushSetupStateRef.current);
    if (!deviceIss) {
      addLog(`ℹ️ skip push token sync (${source}) - no device id`);
      return;
    }
    if (!hasLinkedBindingForCurrentDevice) {
      addLog(`ℹ️ skip push token sync (${source}) - no linked service yet`);
      return;
    }
    if (!registration) {
      addLog(`ℹ️ skip push token sync (${source}) - no APNs registration yet`);
      return;
    }
    if (isPushUploadConfirmed(pushSetupStateRef.current, { deviceIss, registration })) {
      addLog(`ℹ️ skip push token sync (${source}) - already confirmed`);
      return;
    }
    try {
      await syncPushTokenWithServer(registration, source);
    } catch (error) {
      addLog(`ℹ️ push token registration failed (${source}) - ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [addLog, hasLinkedBindingForCurrentDevice, syncPushTokenWithServer]);

  const runForegroundHydration = useCallback(async (source: string) => {
    const deviceIss = currentDeviceIssRef.current;
    if (!deviceIss) {
      return;
    }

    const bindings = await hydrateAuthoritativeBindings(deviceIss, source);
    const nextBindings = bindings.length > 0 ? bindings : effectiveServiceBindingsRef.current;
    if (nextBindings.length > 0) {
      await hydratePendingProofRequests(nextBindings, source);
    }
  }, [hydrateAuthoritativeBindings, hydratePendingProofRequests]);

  const handlePendingProofWake = useCallback(async (
    signal: PresencePendingProofWakeSignal,
    source: string
  ) => {
    const deviceIss = currentDeviceIssRef.current;
    if (!deviceIss) {
      pendingPushWakeRef.current = { signal, source };
      addLog(`🔔 queued pending-proof wake until linked device is available`);
      return;
    }

    if (signal.deviceIss && signal.deviceIss !== deviceIss) {
      addLog(`ℹ️ ignored pending-proof wake for other device ${signal.deviceIss}`);
      return;
    }

    addLog(
      `🔔 pending-proof wake source=${source} request=${signal.requestId} service=${signal.serviceId}`
    );
    pendingPushWakeRef.current = null;
    await runForegroundHydration(source);
  }, [addLog, runForegroundHydration]);

  useEffect(() => {
    if (!showService) return;
    const indicatorTimer = setTimeout(() => {
      serviceScrollRef.current?.flashScrollIndicators();
    }, 150);
    const deviceIss = presence.state?.linkedDevice?.iss;
    if (deviceIss) {
      void hydrateAuthoritativeBindings(deviceIss, "service_modal");
    }
    return () => clearTimeout(indicatorTimer);
  }, [hydrateAuthoritativeBindings, showService, presence.state?.linkedDevice?.iss]);

  useEffect(() => {
    const deviceIss = presence.state?.linkedDevice?.iss;
    if (!deviceIss) return;
    void hydrateAuthoritativeBindings(deviceIss, "presence_state_change");
  }, [hydrateAuthoritativeBindings, presence.state?.linkedDevice?.iss]);

  useEffect(() => {
    if (!currentDeviceIss || !hasLinkedBindingForCurrentDevice || !storedPushTokenKey) {
      return;
    }
    void maybeSyncStoredPushToken("linked_device_available");
  }, [currentDeviceIss, hasLinkedBindingForCurrentDevice, maybeSyncStoredPushToken, storedPushTokenKey]);

  useEffect(() => {
    const pendingWake = pendingPushWakeRef.current;
    if (!currentDeviceIss || !pendingWake) {
      return;
    }
    void handlePendingProofWake(pendingWake.signal, `${pendingWake.source}:buffered`);
  }, [currentDeviceIss, handlePendingProofWake]);

  useEffect(() => {
    if (!currentDeviceIss || !hasLinkedBindingForCurrentDevice || pushRegistrationAttemptedDevicesRef.current.has(currentDeviceIss)) {
      return;
    }
    pushRegistrationAttemptedDevicesRef.current.add(currentDeviceIss);
    void ensurePushNotificationsRegistered({ prompt: true })
      .then(async (result) => {
        await updatePushSetupState((state) => notePushAuthorizationStatus(state, result.status));
        addLog(
          `↻ push registration status=${result.status} requested=${result.registrationRequested ? "yes" : "no"}`
        );
      })
      .catch((error) => {
        addLog(`ℹ️ push registration unavailable - ${error instanceof Error ? error.message : String(error)}`);
      });
  }, [addLog, currentDeviceIss, hasLinkedBindingForCurrentDevice, updatePushSetupState]);

  useEffect(() => {
    let active = true;

    void consumeInitialPushNotificationResponse()
      .then((event) => {
        if (!active || !event) {
          return;
        }
        const signal = extractPendingProofWakeSignal(event.payload);
        if (signal) {
          void handlePendingProofWake(signal, event.source);
        }
      })
      .catch(() => undefined);

    const unsubscribe = addPushNotificationListener({
      onTokenRegistered: (registration) => {
        addLog(`📲 APNs token registered (${registration.environment})`);
        void updatePushSetupState((state) => notePushTokenReceived(state, registration))
          .then(async () => {
            if (pendingLinkPushUploadDeviceIssRef.current) {
              const pendingDeviceIss = pendingLinkPushUploadDeviceIssRef.current;
              try {
                addLog(`↪ queued link completion token upload now starting for ${pendingDeviceIss}`);
                await syncPushTokenWithServer(
                  registration,
                  "token_after_link_completion",
                  {
                    deviceIss: pendingDeviceIss,
                    requireLinkedBinding: false,
                  }
                );
                pendingLinkPushUploadDeviceIssRef.current = null;
              } catch (error) {
                addLog(`ℹ️ push token registration failed (token_after_link_completion) - ${error instanceof Error ? error.message : String(error)}`);
              }
            } else if (!hasLinkedBindingForCurrentDevice) {
            } else if (!hasLinkedBindingForCurrentDevice) {
              addLog("ℹ️ cached APNs token until a linked service is confirmed");
            }
          })
          .catch((error) => {
            addLog(`ℹ️ push token persistence failed - ${error instanceof Error ? error.message : String(error)}`);
          });
      },
      onRegistrationError: (error) => {
        addLog(`ℹ️ APNs registration failed - ${error.message}`);
      },
      onNotificationReceived: (event) => {
        const signal = extractPendingProofWakeSignal(event.payload);
        if (signal) {
          void handlePendingProofWake(signal, event.source);
        }
      },
      onNotificationResponse: (event) => {
        const signal = extractPendingProofWakeSignal(event.payload);
        if (signal) {
          void handlePendingProofWake(signal, event.source);
        }
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [addLog, handlePendingProofWake, hasLinkedBindingForCurrentDevice, updatePushSetupState]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if ((previousState === "background" || previousState === "inactive") && nextState === "active") {
        void maybeSyncStoredPushToken("app_foreground");
        void runForegroundHydration("app_foreground");
      }
    });
    return () => subscription.remove();
  }, [maybeSyncStoredPushToken, runForegroundHydration]);

  const proveOptions = useMemo(() => (openedEnvelope ? buildProveOptionsFromEnvelope(openedEnvelope) : null), [openedEnvelope]);
  const effectiveServiceBindings = useMemo(() => {
    if (
      !presence.state
      || !currentDeviceIss
      || hydratedServiceBindings?.deviceIss !== currentDeviceIss
      || !hydratedServiceBindings.isAuthoritative
    ) {
      return localBindingsForHydration;
    }

    return suppressShadowedLegacyUnsyncableBindings(
      mergeAuthoritativeServiceBindings(
        {
          ...presence.state,
          serviceBindings: localBindingsForHydration,
        },
        hydratedServiceBindings.bindings
      ).serviceBindings
    );
  }, [currentDeviceIss, hydratedServiceBindings, localBindingsForHydration, presence.state]);

  useEffect(() => {
    effectiveServiceBindingsRef.current = effectiveServiceBindings;
  }, [effectiveServiceBindings]);
  const activePendingProofRequests = useMemo(
    () => (
      presence.state
        ? selectPendingProofRequestsForBindings({
            requests: getActivePendingProofRequests(presence.state),
            bindings: effectiveServiceBindings,
            deviceIss: currentDeviceIss,
            statuses: ["pending"],
          })
        : []
    ),
    [currentDeviceIss, effectiveServiceBindings, presence.state]
  );
  const currentPendingProofRequest = useMemo<PendingProofRequest | null>(
    () => (!openedEnvelope ? activePendingProofRequests[0] ?? null : null),
    [activePendingProofRequests, openedEnvelope]
  );
  const latestExpiredPendingProofRequest = useMemo<PendingProofRequest | null>(
    () => {
      if (openedEnvelope || currentPendingProofRequest) {
        return null;
      }
      return selectPendingProofRequestsForBindings({
        requests: presence.state?.pendingProofRequests ?? [],
        bindings: effectiveServiceBindings,
        deviceIss: currentDeviceIss,
        statuses: ["expired"],
      })[0] ?? null;
    },
    [currentDeviceIss, currentPendingProofRequest, effectiveServiceBindings, openedEnvelope, presence.state?.pendingProofRequests]
  );
  const currentPendingRequestedBinding = useMemo(
    () => (
      currentPendingProofRequest
        ? (
          effectiveServiceBindings.find((binding) => (
            binding.bindingId === currentPendingProofRequest.bindingId
            && (!currentDeviceIss || binding.linkedDeviceIss === currentDeviceIss)
          )) ?? null
        )
        : null
    ),
    [currentDeviceIss, currentPendingProofRequest, effectiveServiceBindings]
  );
  const openedRequestedBinding = useMemo(
    () => resolveRequestedLinkedBinding(openedEnvelope, effectiveServiceBindings, currentDeviceIss),
    [effectiveServiceBindings, currentDeviceIss, openedEnvelope]
  );
  const orbRequestedBinding = openedRequestedBinding ?? currentPendingRequestedBinding;
  const currentRequestedProofKey = useMemo(
    () => buildRequestedProofKey({
      requestId: currentPendingProofRequest?.requestId ?? null,
      sessionId: openedEnvelope?.sessionId ?? null,
      bindingId: orbRequestedBinding?.bindingId ?? currentPendingProofRequest?.bindingId ?? null,
      serviceId: openedEnvelope?.serviceId ?? currentPendingProofRequest?.serviceId ?? null,
      accountId: openedEnvelope?.accountId ?? currentPendingProofRequest?.accountId ?? null,
    }),
    [
      currentPendingProofRequest?.accountId,
      currentPendingProofRequest?.bindingId,
      currentPendingProofRequest?.requestId,
      currentPendingProofRequest?.serviceId,
      openedEnvelope?.accountId,
      openedEnvelope?.serviceId,
      openedEnvelope?.sessionId,
      orbRequestedBinding?.bindingId,
    ]
  );
  const latestExpiredRequestedProofKey = useMemo(
    () => latestExpiredPendingProofRequest
      ? buildRequestedProofKey({
        requestId: latestExpiredPendingProofRequest.requestId,
        bindingId: latestExpiredPendingProofRequest.bindingId,
        serviceId: latestExpiredPendingProofRequest.serviceId,
        accountId: latestExpiredPendingProofRequest.accountId ?? null,
      })
      : null,
    [
      latestExpiredPendingProofRequest?.accountId,
      latestExpiredPendingProofRequest?.bindingId,
      latestExpiredPendingProofRequest?.requestId,
      latestExpiredPendingProofRequest?.serviceId,
    ]
  );
  const hasRecovery = effectiveServiceBindings.some((binding) => binding.status === "recovery_pending" || binding.status === "reauth_required");

  useEffect(() => {
    if (!latestExpiredRequestedProofKey || !latestExpiredPendingProofRequest) {
      return;
    }
    rememberRecentProofFailure({
      requestKey: latestExpiredRequestedProofKey,
      status: "expired",
      serviceId: latestExpiredPendingProofRequest.serviceId,
    });
  }, [
    latestExpiredRequestedProofKey,
    latestExpiredPendingProofRequest,
    rememberRecentProofFailure,
  ]);

  const openedSessionAlreadyLinked = !!openedRequestedBinding;
  const openedSessionFlow = openedEnvelope ? inferEnvelopeFlow(openedEnvelope) : null;
  const openedSessionIsInitialLink = openedSessionFlow === "initial_link";
  const recentServiceBindings = [...effectiveServiceBindings]
    .filter((binding) => isActiveBinding(binding))
    .filter((binding) => !currentDeviceIss || binding.linkedDeviceIss === currentDeviceIss)
    .sort((a, b) => {
      const timeA = a.lastVerifiedAt ?? a.linkedAt ?? 0;
      const timeB = b.lastVerifiedAt ?? b.linkedAt ?? 0;
      return timeB - timeA;
    })
    .slice(0, 10);
  const pendingProofBindingsKey = useMemo(
    () => effectiveServiceBindings
      .filter((binding) => binding.status === "linked" && !!binding.sync?.pendingRequestsUrl)
      .map((binding) => `${binding.bindingId}:${binding.sync?.pendingRequestsUrl ?? "-"}`)
      .sort()
      .join("|"),
    [effectiveServiceBindings]
  );
  const hasActionableRequestedProof = !!openedEnvelope || !!currentPendingProofRequest;
  const visibleProofFailureStatus = recentProofFailure
    ? recentProofFailure.requestKey === currentRequestedProofKey
      ? recentProofFailure.status
      : !hasActionableRequestedProof
        ? recentProofFailure.status
        : null
    : null;
  const requestedProofStatus = hasActionableRequestedProof && currentRequestedProofKey && linkedProofRequestState?.requestKey === currentRequestedProofKey
    ? linkedProofRequestState.status
    : visibleProofFailureStatus
      ? visibleProofFailureStatus
      : null;
  const requestedServiceId = openedEnvelope?.serviceId
    ?? currentPendingProofRequest?.serviceId
    ?? recentProofFailure?.serviceId
    ?? null;
  const recentVerifiedServiceId = presence.phase === "ready"
    && !openedEnvelope
    && !currentPendingProofRequest
    && !!recentVerifiedProof
    && recentVerifiedProof.expiresAt > Date.now()
      ? recentVerifiedProof?.serviceId ?? null
      : null;
  const recentConnectedServiceId = !openedEnvelope
    && !currentPendingProofRequest
    && !!recentConnectedLink
    && recentConnectedLink.expiresAt > Date.now()
      ? recentConnectedLink?.serviceId ?? null
      : null;
  const productState = getProductState({
    phase: presence.phase,
    pass: presence.state?.pass,
    hasLocalMeasurement: !!presence.state?.lastMeasuredAt,
    hasRecovery,
    linkedServiceCount: recentServiceBindings.length,
    requestedServiceId,
    requestedProofStatus,
    recentVerifiedServiceId,
    connectedServiceId: recentConnectedServiceId,
  });
  const productTone = colorForProductTone(productState.tone);
  const showActiveRequestHint = hasActionableRequestedProof && !!requestedServiceId && !recentVerifiedServiceId && requestedProofStatus !== "expired";
  const serviceScrollTrackVisible = serviceContentHeight > serviceViewportHeight + 8;
  const serviceScrollThumbHeight = serviceScrollTrackVisible
    ? Math.max(36, (serviceViewportHeight * serviceViewportHeight) / Math.max(serviceContentHeight, 1))
    : 0;
  const serviceScrollMaxOffset = Math.max(serviceContentHeight - serviceViewportHeight, 0);
  const serviceScrollThumbTravel = Math.max(serviceViewportHeight - serviceScrollThumbHeight, 0);
  const serviceScrollThumbTop = serviceScrollTrackVisible && serviceScrollMaxOffset > 0
    ? (serviceScrollOffset / serviceScrollMaxOffset) * serviceScrollThumbTravel
    : 0;
  const displayedErrorCode = presence.error?.code ?? "PRESENCE";
  const displayedErrorMessage = localError ?? presence.error?.message ?? null;
  const showHealthAccessRecovery = isHealthAccessRecoveryNeeded(displayedErrorCode, displayedErrorMessage);
  const isSubmittingPass = presence.phase === "proving" || presence.phase === "measuring" || submittingLinkedProof;

  useEffect(() => {
    if (!presence.state || !currentDeviceIss || !pendingProofBindingsKey) {
      return;
    }
    void hydratePendingProofRequests(effectiveServiceBindings, "foreground_hydration");
  }, [
    currentDeviceIss,
    hydratePendingProofRequests,
    pendingProofBindingsKey,
  ]);

  const clearConnectSession = useCallback(() => {
    setOpenedEnvelope(null);
    setRawLink("");
    setConnectionError(null);
    setLinkedProofRequestState(null);
    setHydratingLinkSession(false);
    setShowConnection(false);
  }, []);

  const handleOpenLink = async () => {
    setConnectionError(null);
    const parsed = parsePresenceLinkUrl(rawLink);
    if (!parsed) {
      setConnectionError("This is not a valid Presence link. Enter a session link in the presence://link format.");
      addLog("❌ Invalid deeplink payload");
      return;
    }
    Keyboard.dismiss();
    const loaded = await activateEnvelope(parsed, "link", rawLink);
    if (!loaded) {
      return;
    }
    addLog(`✅ Link session ${parsed.sessionId} loaded - tap Submit proof to link or answer the request`);
  };

  const handleScanQr = async () => {
    setConnectionError(null);
    setOpenedEnvelope(null);
    setLinkedProofRequestState(null);
    setScannerBusy(true);
    try {
      const payload = await scanQrCode();
      setRawLink(payload);
      const parsed = parsePresenceLinkUrl(payload);
      if (!parsed) {
        setConnectionError("The QR code was read, but it is not a valid Presence link.");
        addLog(`❌ Scanned QR payload was not a Presence link - raw=${payload.slice(0, 180)}`);
        return;
      }
      await activateEnvelope(parsed, "qr", payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("cancelled")) {
        setConnectionError(message);
        addLog(`❌ QR scan failed - ${message}`);
      }
    } finally {
      setScannerBusy(false);
    }
  };

  const handleApprove = async () => {
    setRecentVerifiedProof(null);
    const currentEnvelope = openedEnvelope;
    const pendingRequest = currentPendingProofRequest;
    const pendingBinding = currentPendingRequestedBinding;

    if (!currentEnvelope && pendingRequest && pendingBinding) {
      const requestKey = currentRequestedProofKey ?? buildRequestedProofKey({
        requestId: pendingRequest.requestId,
        bindingId: pendingBinding.bindingId,
        serviceId: pendingRequest.serviceId,
        accountId: pendingRequest.accountId ?? null,
      });
      setSubmittingLinkedProof(true);
      if (requestKey) {
        setLinkedProofRequestState({ requestKey, status: "submitting" });
      }
      addLog(
        `→ submit pending proof request request=${pendingRequest.requestId} binding=${pendingBinding.bindingId} service=${pendingRequest.serviceId}`
      );

      try {
        const result = await submitPendingProofRequest({
          request: pendingRequest,
          binding: pendingBinding,
        });
        const refreshedState = await presence.refresh();

        addLog(
          `✅ pending proof attempt finished - request=${result.requestId} binding=${result.bindingId} status=${result.status}`
        );
        addLog(
          `   state: created=${refreshedState?.stateCreatedAt ?? '-'} validUntil=${refreshedState?.stateValidUntil ?? '-'} measured=${refreshedState?.lastMeasuredAt ?? '-'} phase=${refreshedState?.status ?? '-'}`
        );

        if (result.status === "verified") {
          setLocalError(null);
          rememberRecentVerifiedProof(pendingRequest.serviceId);
          if (requestKey) {
            setLinkedProofRequestState(null);
            clearRecentProofFailure(requestKey);
          }
          void hydratePendingProofRequests(effectiveServiceBindings, "post_pending_submit");
          return;
        }

        if (requestKey) {
          rememberRecentProofFailure({
            requestKey,
            status: "failed",
            serviceId: pendingRequest.serviceId,
          });
          setLinkedProofRequestState(null);
        }
        setLocalError("This linked service needs recovery or relink before it can accept proof from this device.");
        return;
      } catch (error) {
        await presence.refresh();
        const message = error instanceof Error ? error.message : String(error);
        if (requestKey) {
          rememberRecentProofFailure({
            requestKey,
            status: "failed",
            serviceId: pendingRequest.serviceId,
          });
          setLinkedProofRequestState(null);
        }
        setLocalError(`Could not submit the pending proof request: ${message}`);
        addLog(`❌ pending proof error - ${message}`);
        return;
      } finally {
        setSubmittingLinkedProof(false);
      }
    }

    if (!currentEnvelope && pendingRequest && !pendingBinding) {
      setLocalError("This pending proof request no longer matches an active linked service on this device.");
      addLog(`❌ pending proof request ${pendingRequest.requestId} could not be matched to an active binding`);
      return;
    }

    if (!currentEnvelope) {
      setLocalError("Open a link session first.");
      return;
    }

    const envelopeSync = syncFromEnvelope(currentEnvelope);
    const requestedBindingResolution = inferRequestedBindingResolution(currentEnvelope, openedRequestedBinding);
    addLog(
      `🔎 request boundary envelope=present session=${currentEnvelope.sessionId} flow=${currentEnvelope.flow ?? (currentEnvelope.bindingId ? "reauth" : "initial_link")}`
    );
    addLog(
      `🔎 requested binding resolution method=${requestedBindingResolution} binding_hint=${currentEnvelope.bindingId ?? "-"} service=${currentEnvelope.serviceId ?? "-"} account=${currentEnvelope.accountId ?? "-"} resolved=${openedRequestedBinding?.bindingId ?? "missing"}`
    );
    addLog(
      `   envelope sync: ${describeBindingSync(envelopeSync)} nonce=${describePresenceValue(currentEnvelope.nonce)}`
    );
    const route = shouldUseLinkedVerifyRoute({
      envelope: currentEnvelope,
      openedRequestedBinding,
    }) ? "linked_verify" : "initial_link_prove";
    addLog(
      `🧭 submit route=${route} flow=${currentEnvelope.flow ?? (currentEnvelope.bindingId ? "reauth" : "initial_link")} binding_hint=${currentEnvelope.bindingId ? "present" : "absent"} trust=${[
        `service_domain=${currentEnvelope.serviceDomain ? "present" : "missing"}`,
        `status_url=${currentEnvelope.statusUrl ? "present" : "missing"}`,
        `nonce_url=${currentEnvelope.nonceUrl ? "present" : "missing"}`,
        `verify_url=${currentEnvelope.verifyUrl ? "present" : "missing"}`,
      ].join(",")}`
    );
    addLog(
      `   requested binding sync: ${describeBindingSync(openedRequestedBinding?.sync)} nonce_source=${currentEnvelope.nonce ? "envelope" : openedRequestedBinding?.sync?.nonceUrl ? "binding_sync" : "missing"}`
    );

    if (route === "linked_verify" && openedRequestedBinding) {
      const diagnostics: string[] = [];
      const requestKey = currentRequestedProofKey ?? buildRequestedProofKey({
        sessionId: currentEnvelope.sessionId,
        bindingId: openedRequestedBinding.bindingId,
        serviceId: currentEnvelope.serviceId ?? null,
        accountId: currentEnvelope.accountId ?? null,
      });
      setSubmittingLinkedProof(true);
      if (requestKey) {
        setLinkedProofRequestState({ requestKey, status: "submitting" });
      }
      addLog(
        `→ submit linked proof request binding=${openedRequestedBinding.bindingId} service=${openedRequestedBinding.serviceId}`
      );

      try {
        await persistSeededBinding(openedRequestedBinding);
        addLog(`↻ persisted linked request sync - ${describeBindingSync(openedRequestedBinding.sync)}`);

        const result = await submitLinkedBindingProof({
          binding: openedRequestedBinding,
          nonce: currentEnvelope.nonce,
          diagnostics,
        });
        const refreshedState = await presence.refresh();

        addLog(
          `✅ linked proof attempt finished - binding=${result.bindingId} status=${result.status} nonce=${result.nonce ? "present" : "missing"}`
        );
        addLog(
          `   state: created=${refreshedState?.stateCreatedAt ?? '-'} validUntil=${refreshedState?.stateValidUntil ?? '-'} measured=${refreshedState?.lastMeasuredAt ?? '-'} phase=${refreshedState?.status ?? '-'}`
        );
        for (const diagnosticLine of formatGroupedLogEntries("diagnostics", diagnostics)) {
          addLog(`   ${diagnosticLine}`);
        }

        if (result.status === "verified") {
          setLocalError(null);
          rememberRecentVerifiedProof(openedRequestedBinding.serviceId);
          if (requestKey) {
            setLinkedProofRequestState(null);
            clearRecentProofFailure(requestKey);
          }
          clearConnectSession();
          return;
        }

        if (requestKey) {
          rememberRecentProofFailure({
            requestKey,
            status: "failed",
            serviceId: openedRequestedBinding.serviceId,
          });
          setLinkedProofRequestState(null);
        }
        if (result.status === "recovery_required") {
          setLocalError("This linked service needs recovery or relink before it can accept proof from this device.");
          return;
        }

        setLocalError(refreshedState?.lastMeasurementReason ?? "This device is not ready to submit PASS.");
        return;
      } catch (error) {
        await presence.refresh();
        const message = error instanceof Error ? error.message : String(error);
        if (requestKey) {
          rememberRecentProofFailure({
            requestKey,
            status: "failed",
            serviceId: openedRequestedBinding.serviceId,
          });
          setLinkedProofRequestState(null);
        }
        setLocalError(`Could not submit proof to the linked service: ${message}`);
        addLog(`❌ linked proof error - ${message}`);
        for (const diagnosticLine of formatGroupedLogEntries("diagnostics", diagnostics)) {
          addLog(`   ${diagnosticLine}`);
        }
        return;
      } finally {
        setSubmittingLinkedProof(false);
      }
    }

    if (!proveOptions) {
      setLocalError("Open a valid link session first.");
      return;
    }

    addLog(`→ approve ${proveOptions.flow ?? "initial_link"} session`);
    const payload = await presence.prove(proveOptions);
    if (!payload) {
      setLocalError(presence.error?.message ?? "Could not create the proof.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} - ${presence.error?.message ?? ""}`);
      return;
    }

    setLocalError(null);
    addLog("✅ Proof generated with link_context");
    addLog(`   link_session_id: ${payload.link_context?.link_session_id ?? "n/a"}`);
    addLog(`   binding_id: ${payload.link_context?.binding_id ?? "server-created"}`);

    const completionUrl = buildCompletionUrl(currentEnvelope);
    if (!completionUrl) {
      const message = "This link is missing a valid absolute status_url/completion URL. Ask the service to rewrite public completion URLs before rendering the link.";
      setLocalError(message);
      addLog("❌ completion blocked - status_url missing or not absolute");
      return;
    }

    try {
      addLog(`↗ POST complete ${completionUrl}`);
      const response = await fetch(completionUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const raw = await response.text();
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }

      if (!response.ok) {
        const message = typeof parsed === "object" && parsed && "message" in parsed
          ? String((parsed as { message?: unknown }).message ?? "")
          : raw || `HTTP ${response.status}`;
        setLocalError(`Server completion failed: ${message}`);
        addLog(`❌ completion ${response.status} - ${truncateJson(parsed || raw, 600)}`);
        return;
      }

      const completionResult = parsed as CompletionSuccessResponse;
      const seedResult = await seedConfirmedBinding(completionResult, currentEnvelope);
      if (!seedResult.ok) {
        setLocalError(seedResult.message);
        addLog(`❌ completion seed rejected - ${seedResult.message}`);
        addLog(`   response: ${truncateJson(parsed, 500)}`);
        return;
      }

      const connectedServiceId = completionResult.binding?.serviceId ?? currentEnvelope?.serviceId ?? "presence-demo";
      const linkedDeviceIss = completionResult.binding?.deviceIss ?? currentDeviceIss ?? null;
      const completionToken = getLatestPushToken(pushSetupStateRef.current);
      addLog(
        `ℹ️ completion push-sync check - linked_device=${linkedDeviceIss ?? "n/a"} token=${completionToken ? `present (${completionToken.environment})` : "missing"}`
      );
      if (linkedDeviceIss && completionToken) {
        pendingLinkPushUploadDeviceIssRef.current = null;
        try {
          await hydrateAuthoritativeBindings(linkedDeviceIss, "link_completion");
        } catch {
          // hydration failures are handled internally and surfaced by logs; continue with local retry path.
        }
        void syncPushTokenWithServer(
          completionToken,
          "link_completion",
          {
            deviceIss: linkedDeviceIss,
            requireLinkedBinding: false,
          }
        ).catch((error) => {
          addLog(`ℹ️ push token registration failed (link_completion) - ${error instanceof Error ? error.message : String(error)}`);
        });
      } else if (linkedDeviceIss) {
        pendingLinkPushUploadDeviceIssRef.current = linkedDeviceIss;
        addLog(`ℹ️ queued link completion token upload pending APNs token for ${linkedDeviceIss}`);
      } else {
        addLog("⚠️ completion push-sync skipped: no device id in completion response or app state");
      }

      rememberRecentConnectedLink(connectedServiceId);
      clearConnectSession();
      addLog(`✅ completion ${response.status} - binding saved on server${seedResult.seeded ? " and seeded locally" : ""}`);
      addLog(`   response: ${truncateJson(parsed, 500)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`Could not reach the completion endpoint: ${message}`);
      addLog(`❌ completion network error - ${message}`);
      return;
    }
  };

  const handleMeasure = async () => {
    addLog("→ run local-only check");
    setLinkedProofRequestState(null);
    setRecentVerifiedProof(null);
    const result = await runLocalMeasurement();
    if (!result) {
      setLocalError(presence.error?.message ?? "Could not complete the measurement.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} - ${presence.error?.message ?? ""}`);
      return;
    }

    if (result.pass) {
      setLocalError(null);
      return;
    }

    setLocalError(result.reason);
  };

  const handleOrbPress = useCallback(() => {
    if (openedEnvelope || currentPendingProofRequest) {
      void handleApprove();
      return;
    }

    if (requestedProofStatus === "expired") {
      const serviceLabel = requestedServiceId ?? "The latest";
      setLocalError(`${serviceLabel} request expired. Open a fresh request before submitting proof.`);
      addLog(`ℹ️ expired request blocked local proof action - service=${requestedServiceId ?? "-"}`);
      return;
    }

    void handleMeasure();
  }, [
    addLog,
    currentPendingProofRequest,
    handleApprove,
    handleMeasure,
    openedEnvelope,
    requestedProofStatus,
    requestedServiceId,
  ]);

  const handleManualRefresh = useCallback(async () => {
    if (isManualRefreshing) {
      return;
    }

    setIsManualRefreshing(true);
    try {
      addLog("↻ manual refresh requested");
      await runForegroundHydration("manual_refresh");
      await presence.refresh();
      addLog("✅ manual refresh completed");
    } catch (error) {
      addLog("ℹ️ manual refresh failed - " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsManualRefreshing(false);
    }
  }, [addLog, isManualRefreshing, runForegroundHydration, presence.refresh]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.screen}>
        <View style={styles.topRow}>
          <TouchableOpacity style={styles.qrButton} onPress={() => setShowConnection(true)} activeOpacity={0.85}>
            <Text style={styles.qrIcon}>⌁</Text>
          </TouchableOpacity>
          <View style={styles.topCenterStack}>
            <View style={[styles.statePill, styles.statePillLight, { borderColor: productTone }]}>
              <Text style={[styles.stateLabel, { color: productTone }]}>{productState.label}</Text>
            </View>
            {showActiveRequestHint ? (
              <View style={styles.activeRequestPill}>
                <Text style={styles.activeRequestPillText}>Active request</Text>
              </View>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.refreshButton, isManualRefreshing && styles.refreshButtonDisabled]}
            onPress={() => void handleManualRefresh()}
            disabled={isManualRefreshing}
            activeOpacity={0.85}
          >
            <View style={styles.refreshIconWrap}>
              <Text style={styles.refreshIconText}>↻</Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.heroCard}>
          <TouchableOpacity
            style={styles.heroImageWrap}
            onPress={handleOrbPress}
            disabled={isSubmittingPass}
            activeOpacity={0.9}
          >
            {isSubmittingPass
              ? <ActivityIndicator color={C.text} style={styles.heroSpinner} />
              : null}
            <Image source={ORB_IMAGE} style={styles.heroImage} resizeMode="contain" />
          </TouchableOpacity>
        </View>

        {(localError || presence.error) && (
          <View style={styles.errorBox}>
            <Text style={styles.errorCode}>{displayedErrorCode}</Text>
            <Text style={styles.errorMsg}>{displayedErrorMessage}</Text>
            {showHealthAccessRecovery ? (
              <>
                <Text style={styles.errorHint}>
                  Health access is required to compute PASS and submit proof. Open App Settings for app permissions. If Health access is still off, open the Health app → Data Access & Devices → Presence, then allow read access for Heart Rate and Steps.
                </Text>
                <TouchableOpacity
                  style={styles.errorActionButton}
                  onPress={() => {
                    void Linking.openSettings();
                    addLog("↗ Opened Settings for Health access recovery");
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.errorActionButtonText}>Open Settings</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        )}

        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.bottomBarButton} onPress={() => setShowService(true)} activeOpacity={0.85}>
            <Text style={styles.bottomBarButtonText}>LINKED SERVICES</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={showService} transparent animationType="fade" onRequestClose={() => setShowService(false)}>
          <View style={styles.modalBackdrop}>
            <TouchableOpacity style={styles.modalBackdropPressable} onPress={() => setShowService(false)} activeOpacity={1} />
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.sectionTitle}>Linked Services</Text>
                <TouchableOpacity onPress={() => setShowService(false)} activeOpacity={0.85}>
                  <Text style={styles.modalClose}>Close</Text>
                </TouchableOpacity>
              </View>

              {hydratingServiceBindings ? (
                <Text style={styles.modalMeta}>Syncing linked services…</Text>
              ) : serviceBindingsHydrationError ? (
                <Text style={styles.modalMeta}>Service sync fallback: {serviceBindingsHydrationError}</Text>
              ) : syncingPendingRequests ? (
                <Text style={styles.modalMeta}>Syncing pending proof requests…</Text>
              ) : pendingRequestsSyncError ? (
                <Text style={styles.modalMeta}>Pending request sync fallback: {pendingRequestsSyncError}</Text>
              ) : null}

              {recentServiceBindings.length > 0 ? (
                <View
                  style={styles.bindingViewport}
                  onLayout={(event) => setServiceViewportHeight(event.nativeEvent.layout.height)}
                >
                  <ScrollView
                    style={styles.bindingListScroll}
                    contentContainerStyle={styles.bindingList}
                    showsVerticalScrollIndicator
                    keyboardShouldPersistTaps="handled"
                    bounces={false}
                    scrollEventThrottle={16}
                    onContentSizeChange={(_, height) => setServiceContentHeight(height)}
                    onScroll={(event) => setServiceScrollOffset(event.nativeEvent.contentOffset.y)}
                  >
                    {recentServiceBindings.map((binding) => (
                      <View key={binding.bindingId} style={styles.bindingCard}>
                        <KeyValue label="service" value={getBindingServiceDisplay(binding)} />
                        <KeyValue label="account" value={binding.accountId ?? "-"} />
                        <KeyValue
                          label="connected"
                          value={new Date((binding.lastVerifiedAt ?? binding.linkedAt ?? 0) * 1000).toLocaleString()}
                        />
                      </View>
                    ))}
                  </ScrollView>
                  {serviceScrollTrackVisible ? (
                    <View pointerEvents="none" style={styles.bindingScrollRail}>
                      <View
                        style={[
                          styles.bindingScrollThumb,
                          {
                            height: serviceScrollThumbHeight,
                            transform: [{ translateY: serviceScrollThumbTop }],
                          },
                        ]}
                      />
                    </View>
                  ) : null}
                </View>
              ) : (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>No linked services yet</Text>
                  <Text style={styles.emptyBody}>Complete an initial Presence link from your service to populate this list.</Text>
                </View>
              )}
            </View>
          </View>
        </Modal>

        <Modal visible={showConnection} transparent animationType="fade" onRequestClose={() => setShowConnection(false)}>
          <TouchableWithoutFeedback
            onPress={() => {
              Keyboard.dismiss();
              setConnectionError(null);
              setShowConnection(false);
            }}
          >
            <KeyboardAvoidingView
              style={styles.modalBackdrop}
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              keyboardVerticalOffset={8}
            >
              <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <ScrollView contentContainerStyle={styles.connectionScrollContent} keyboardShouldPersistTaps="handled">
                  <View style={styles.modalCard}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.sectionTitle}>Connect</Text>
                    <TouchableOpacity onPress={() => setShowConnection(false)} activeOpacity={0.85}>
                      <Text style={styles.modalClose}>Close</Text>
                    </TouchableOpacity>
                  </View>

                  {scannerSupported ? (
                    <TouchableOpacity
                      style={[styles.scanQrButton, scannerBusy && styles.buttonDisabled]}
                      onPress={handleScanQr}
                      disabled={scannerBusy}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.scanQrButtonText}>{scannerBusy ? "Preparing…" : "Scan QR"}</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.connectionOptions}>
                      <View style={styles.optionPillMuted}>
                        <Text style={styles.optionPillText}>Requires a real iPhone</Text>
                      </View>
                    </View>
                  )}

                  <View style={styles.connectionOptions}>
                    <View style={styles.optionCard}>
                      <Text style={styles.optionTitle}>Link Service</Text>
                      {!openedEnvelope ? (
                        <TextInput
                          style={styles.inputInline}
                          value={rawLink}
                          onChangeText={(value) => {
                            setRawLink(value);
                            setConnectionError(null);
                            setOpenedEnvelope(null);
                            setLinkedProofRequestState(null);
                          }}
                          placeholder="Paste a presence://link here"
                          placeholderTextColor={C.subtext}
                          multiline
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      ) : null}
                    </View>
                  </View>

                  {openedEnvelope ? (
                    <View style={styles.loadedSessionCard}>
                      <Text style={styles.loadedSessionLabel}>Submit proof to service</Text>
                      <Text style={styles.loadedSessionBody}>
                        {openedSessionAlreadyLinked
                          ? "This service/account is already linked. Presence will submit proof directly to the linked binding and refresh the saved sync metadata for future requests."
                          : openedSessionIsInitialLink
                            ? "Tap the orb to link"
                            : "Request loaded. Review the details below, then tap Submit proof. Initial links connect the service; later requests submit proof on demand."}
                      </Text>
                      <View style={styles.loadedSessionMeta}>
                        <KeyValue label="Service" value={openedEnvelope.serviceId ?? "unknown"} />
                        <KeyValue label="Service domain" value={openedEnvelope.serviceDomain ?? "not supplied"} />
                        <KeyValue label="Session" value={openedEnvelope.sessionId} mono />
                        <KeyValue label="Flow" value={openedEnvelope.flow ?? (openedRequestedBinding ? "reauth" : "initial_link")} />
                        <KeyValue label="Code" value={openedEnvelope.code ?? "none"} mono />
                        {openedRequestedBinding ? (
                          <KeyValue label="Binding" value={openedRequestedBinding.bindingId} mono />
                        ) : null}
                      </View>
                      <TouchableOpacity
                        style={[styles.primaryActionButton, isSubmittingPass && styles.buttonDisabled]}
                        onPress={handleApprove}
                        disabled={isSubmittingPass}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.primaryActionButtonText}>
                          {isSubmittingPass ? "Submitting proof…" : "Submit proof"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.ghostButton}
                        onPress={() => {
                          setOpenedEnvelope(null);
                          setLinkedProofRequestState(null);
                          setLocalError(null);
                          setRawLink("");
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.ghostButtonText}>Choose different request</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      <TouchableOpacity style={styles.primaryActionButton} onPress={handleOpenLink} activeOpacity={0.85}>
                        <Text style={styles.primaryActionButtonText}>Open request</Text>
                      </TouchableOpacity>

                      {hydratingLinkSession ? (
                        <View style={styles.connectionErrorBox}>
                          <Text style={styles.connectionErrorCode}>LOADING</Text>
                          <Text style={styles.connectionErrorText}>Loading session details for this link…</Text>
                        </View>
                      ) : null}
                      {connectionError ? (
                        <View style={styles.connectionErrorBox}>
                          <Text style={styles.connectionErrorCode}>CONNECT</Text>
                          <Text style={styles.connectionErrorText}>{connectionError}</Text>
                        </View>
                      ) : null}
                    </>
                  )}
                </View>
                </ScrollView>
              </TouchableWithoutFeedback>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

function getBindingServiceDisplay(binding: ServiceBinding): string {
  return binding.sync?.serviceDomain?.trim() || binding.serviceId;
}

function KeyValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, mono && styles.kvMono]} numberOfLines={4}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
  },
  screen: {
    flex: 1,
    padding: 20,
    paddingBottom: 24,
    gap: 16,
  },
  mainSpacer: {
    height: 0,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 14,
    position: "relative",
  },
  qrButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  qrIcon: {
    color: C.qr,
    fontSize: 23,
    fontWeight: "700",
  },
  topCenterStack: {
    position: "absolute",
    top: 6,
    left: 0,
    right: 0,
    width: "100%",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 6,
    zIndex: 1,
    pointerEvents: "none",
  },
  refreshButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  refreshButtonDisabled: {
    opacity: 0.6,
  },
  refreshIconWrap: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  refreshIconText: {
    color: C.text,
    fontSize: 20,
    lineHeight: 22,
    fontWeight: "700",
    includeFontPadding: false,
    textAlign: "center",
    textAlignVertical: "center",
  },
  activeRequestPill: {
    alignSelf: "center",
    borderRadius: 999,
    backgroundColor: C.surfaceSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    paddingHorizontal: 11,
    paddingVertical: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  activeRequestPillText: {
    color: C.subtext,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: "600",
    letterSpacing: 0.2,
    includeFontPadding: false,
    textAlignVertical: "center",
  },
  wordmarkWrap: {
    gap: 2,
  },
  wordmark: {
    color: C.text,
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  wordmarkSub: {
    color: C.subtext,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  heroCard: {
    flex: 1.25,
    backgroundColor: C.panel,
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingVertical: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  heroCopy: {
    alignItems: "center",
    gap: 6,
    marginTop: -2,
  },
  heroEyebrow: {
    color: C.subtext,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.8,
  },
  heroImageWrap: {
    width: "100%",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginTop: -20,
  },
  heroImage: {
    width: "72%",
    height: 360,
  },
  heroSpinner: {
    position: "absolute",
    zIndex: 1,
  },
  statePill: {
    alignSelf: "center",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  statePillLight: {
    backgroundColor: "#FFFFFF",
  },
  stateLabel: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  heroTitle: {
    color: C.text,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  heroBody: {
    color: C.subtext,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  metaChip: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: C.surfaceSoft,
    borderWidth: 1,
    borderColor: C.border,
  },
  metaChipText: {
    color: C.subtext,
    fontSize: 12,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 999,
    backgroundColor: C.text,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    paddingHorizontal: 20,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonSpinner: {
    marginRight: 8,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  heroHint: {
    color: C.subtext,
    fontSize: 12,
    lineHeight: 18,
  },
  errorBox: {
    backgroundColor: "#251315",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#5b262d",
    padding: 14,
    gap: 4,
  },
  errorCode: {
    color: C.error,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: MONO_FONT,
  },
  errorMsg: {
    color: "#ffc5c5",
    fontSize: 13,
    lineHeight: 19,
  },
  errorHint: {
    marginTop: 10,
    color: "#f3d9d9",
    fontSize: 12,
    lineHeight: 18,
  },
  errorActionButton: {
    marginTop: 12,
    alignSelf: "flex-start",
    minHeight: 40,
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff4f4",
  },
  errorActionButtonText: {
    color: C.error,
    fontSize: 13,
    fontWeight: "700",
  },
  sectionCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
  },
  sectionHeader: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 6,
  },
  sectionEyebrow: {
    color: C.subtext,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.6,
  },
  sectionTitle: {
    color: C.text,
    fontSize: 20,
    fontWeight: "700",
  },
  sectionBody: {
    color: C.subtext,
    fontSize: 14,
    lineHeight: 21,
  },
  statusBanner: {
    marginHorizontal: 18,
    marginBottom: 6,
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
  statusBannerDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    marginTop: 6,
  },
  statusBannerTextWrap: {
    flex: 1,
    gap: 4,
  },
  statusBannerLabel: {
    fontSize: 14,
    fontWeight: "800",
  },
  statusBannerDetail: {
    color: C.text,
    fontSize: 13,
    lineHeight: 19,
  },
  journeyWrap: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 12,
  },
  stepRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
  stepDot: {
    width: 12,
    height: 12,
    borderRadius: 999,
    marginTop: 5,
    borderWidth: 1,
    borderColor: C.border,
  },
  stepDotDone: {
    backgroundColor: C.success,
  },
  stepDotCurrent: {
    backgroundColor: C.accent,
  },
  stepDotTodo: {
    backgroundColor: C.surface,
  },
  stepTextWrap: {
    flex: 1,
    gap: 2,
  },
  stepTitle: {
    color: C.text,
    fontSize: 14,
    fontWeight: "700",
  },
  stepDetail: {
    color: C.subtext,
    fontSize: 13,
    lineHeight: 19,
  },
  bindingBanner: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 4,
  },
  bindingTitle: {
    fontSize: 14,
    fontWeight: "800",
  },
  bindingBody: {
    color: C.subtext,
    fontSize: 13,
    lineHeight: 19,
  },
  bindingViewport: {
    height: 360,
    overflow: "hidden",
    position: "relative",
  },
  bindingListScroll: {
    flex: 1,
  },
  bindingList: {
    paddingHorizontal: 18,
    paddingRight: 24,
    paddingBottom: 18,
    gap: 12,
  },
  bindingScrollRail: {
    position: "absolute",
    top: 12,
    right: 8,
    bottom: 12,
    width: 4,
    borderRadius: 999,
    backgroundColor: "rgba(15, 23, 42, 0.08)",
    overflow: "hidden",
  },
  bindingScrollThumb: {
    width: "100%",
    borderRadius: 999,
    backgroundColor: "rgba(15, 23, 42, 0.32)",
  },
  bindingScrollRailDebug: {
    position: "absolute",
    top: 12,
    right: 6,
    bottom: 12,
    width: 8,
    borderRadius: 999,
    backgroundColor: "rgba(239, 68, 68, 0.28)",
    overflow: "hidden",
    zIndex: 20,
  },
  bindingScrollThumbDebug: {
    width: "100%",
    minHeight: 56,
    borderRadius: 999,
    backgroundColor: "rgba(220, 38, 38, 0.9)",
  },
  bindingScrollThumbStatic: {
    height: 56,
  },
  bindingCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    overflow: "hidden",
  },
  emptyCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    paddingHorizontal: 18,
    paddingVertical: 16,
    gap: 6,
  },
  emptyTitle: {
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
  },
  emptyBody: {
    color: C.subtext,
    fontSize: 13,
    lineHeight: 19,
  },
  connectionOptions: {
    paddingHorizontal: 18,
    gap: 12,
  },
  optionCard: {
    backgroundColor: C.surfaceSoft,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 8,
    minHeight: 108,
    justifyContent: "space-between",
  },
  optionIcon: {
    color: C.accent,
    fontSize: 22,
    fontWeight: "700",
  },
  optionTitle: {
    color: C.text,
    fontSize: 17,
    fontWeight: "700",
  },
  optionBody: {
    color: C.subtext,
    fontSize: 14,
    lineHeight: 20,
  },
  optionPillMuted: {
    alignSelf: "flex-start",
    backgroundColor: C.surface,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  optionPillText: {
    color: C.subtext,
    fontSize: 12,
    fontWeight: "600",
  },
  secondaryButton: {
    marginTop: 2,
    alignSelf: "flex-start",
    backgroundColor: C.accentSoft,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  secondaryButtonText: {
    color: C.accent,
    fontSize: 14,
    fontWeight: "700",
  },
  scanQrButton: {
    marginHorizontal: 18,
    marginTop: 4,
    borderRadius: 16,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surfaceSoft,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 16,
  },
  scanQrButtonText: {
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
  },
  ghostButton: {
    margin: 18,
    marginTop: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surfaceSoft,
  },
  ghostButtonText: {
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
  },
  primaryActionButton: {
    marginHorizontal: 18,
    marginTop: 10,
    borderRadius: 16,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.accent,
    paddingHorizontal: 16,
  },
  primaryActionButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  loadedSessionCard: {
    marginHorizontal: 18,
    marginTop: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    padding: 14,
    gap: 10,
  },
  loadedSessionLabel: {
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
  },
  loadedSessionBody: {
    color: C.subtext,
    fontSize: 13,
    lineHeight: 19,
  },
  loadedSessionMeta: {
    gap: 0,
  },
  inlineHint: {
    color: C.subtext,
    fontSize: 12,
    lineHeight: 18,
    marginHorizontal: 18,
    marginTop: 10,
  },
  input: {
    minHeight: 78,
    marginHorizontal: 18,
    marginTop: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    color: C.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlignVertical: "top",
  },
  inputInline: {
    minHeight: 78,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    color: C.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlignVertical: "top",
  },
  connectionErrorBox: {
    marginHorizontal: 18,
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#F0C9C9",
    backgroundColor: "#FFF6F6",
    padding: 12,
    gap: 6,
  },
  connectionErrorCode: {
    color: C.error,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  connectionErrorText: {
    color: C.error,
    fontSize: 13,
    lineHeight: 19,
  },
  sessionCard: {
    marginHorizontal: 18,
    marginBottom: 18,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    overflow: "hidden",
  },
  sessionTitle: {
    color: C.text,
    fontSize: 14,
    fontWeight: "700",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  kvRow: {
    flexDirection: "row",
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: "flex-start",
  },
  kvLabel: {
    width: 82,
    color: C.subtext,
    fontSize: 12,
    paddingTop: 2,
  },
  kvValue: {
    flex: 1,
    color: C.text,
    fontSize: 13,
    lineHeight: 19,
  },
  kvMono: {
    fontFamily: MONO_FONT,
    color: C.mono,
    fontSize: 11,
  },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 8,
    marginBottom: 6,
  },
  bottomBarButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBarButtonText: {
    color: C.subtext,
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.3,
  },
  moreButton: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  moreButtonText: {
    color: C.subtext,
    fontSize: 14,
  },
  devToggle: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  devToggleText: {
    color: C.subtext,
    fontSize: 13,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.18)",
    justifyContent: "flex-end",
  },
  modalBackdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  modalCard: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 18,
    paddingBottom: 28,
    paddingHorizontal: 18,
    gap: 12,
  },
  connectionScrollContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  modalCardLarge: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 18,
    paddingHorizontal: 18,
    paddingBottom: 22,
    maxHeight: "78%",
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  modalClose: {
    color: C.subtext,
    fontSize: 14,
  },
  modalMeta: {
    color: C.subtext,
    fontSize: 12,
    marginTop: -4,
    marginBottom: 4,
  },
  modalScroll: {
    gap: 16,
    paddingBottom: 20,
  },
  logSummaryCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    padding: 14,
    gap: 8,
  },
  logSummaryLabel: {
    color: C.subtext,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  logSummaryBody: {
    color: C.text,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: MONO_FONT,
  },
  logActionRow: {
    flexDirection: "row",
    gap: 10,
  },
  logActionButton: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  logActionPrimary: {
    flex: 1,
    backgroundColor: C.accent,
  },
  logActionSecondary: {
    minWidth: 92,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
  },
  logActionPrimaryText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  logActionSecondaryText: {
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
  },
  logViewport: {
    flex: 1,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: "#FCFBF8",
  },
  logList: {
    paddingVertical: 6,
  },
  devButton: {
    marginHorizontal: 18,
    marginBottom: 10,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  devButtonText: {
    color: C.text,
    fontSize: 14,
    fontWeight: "600",
  },
  codeBlock: {
    color: C.mono,
    fontFamily: MONO_FONT,
    fontSize: 10,
    lineHeight: 16,
    paddingHorizontal: 18,
    paddingBottom: 18,
  },
  logEntry: {
    color: C.subtext,
    fontFamily: MONO_FONT,
    fontSize: 11,
    lineHeight: 17,
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
});
