import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { usePresenceRenewal } from "./src/ui/usePresenceRenewal";
import {
  loadPresenceState,
  savePresenceState,
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
import type { ServiceBinding } from "./src/types/index";
import type { ProveOptions } from "./src/service";
import { isQrScannerSupported, scanQrCode } from "./src/qrScanner";
import { getInitialPresenceLink, subscribeToPresenceLinks } from "./src/ui/connectionLinking";
import { syncLinkedBindings, type LinkedBindingSyncError } from "./src/sync/linkedBindings";

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

function nowTime(): string {
  return new Date().toISOString().slice(11, 19);
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

function formatSyncErrorEntries(errors: LinkedBindingSyncError[]): string[] {
  return formatGroupedLogEntries(
    "errors",
    errors.map((error) => `${error.bindingId}=${error.message}`),
    2
  );
}

function buildCompletionUrl(envelope: LinkCompletionEnvelope | null): string | null {
  if (!envelope?.statusUrl) return null;
  return envelope.statusUrl.endsWith("/complete")
    ? envelope.statusUrl
    : `${envelope.statusUrl.replace(/\/$/, "")}/complete`;
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
  device?: { iss?: string } | null;
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

interface CompletionSuccessResponse {
  ok: true;
  state?: "linked";
  binding?: CompletionBindingRecord;
}

type SeedConfirmedBindingResult =
  | { ok: true; seeded: boolean }
  | { ok: false; message: string };

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : null;
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
  ].join(" ");
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

  return {
    bindingId: binding.bindingId,
    serviceId: binding.serviceId,
    accountId: binding.accountId,
    linkedDeviceIss: binding.deviceIss,
    linkedAt: binding.lastLinkedAt ?? binding.createdAt ?? binding.updatedAt ?? Math.floor(Date.now() / 1000),
    lastVerifiedAt: binding.lastVerifiedAt,
    status: binding.status as ServiceBinding["status"],
    sync: normalizeBindingSyncMetadata(sync),
  };
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

function envelopeToProveOptions(envelope: LinkCompletionEnvelope): ProveOptions | null {
  if (!envelope.nonce) return null;
  const envelopeSync = syncFromEnvelope(envelope);
  return {
    nonce: envelope.nonce,
    flow: envelope.flow ?? (envelope.bindingId ? "reauth" : "initial_link"),
    linkSession: {
      id: envelope.sessionId,
      serviceId: envelope.serviceId ?? "presence-demo",
      accountId: envelope.accountId,
      recoveryCode: envelope.code,
      completion: {
        method: envelope.method ?? "deeplink",
        returnUrl: envelope.returnUrl,
        fallbackCode: envelope.code,
        sync: envelopeSync,
      },
    },
    bindingHint: envelope.bindingId
        ? {
          bindingId: envelope.bindingId,
          serviceId: envelope.serviceId ?? "presence-demo",
          accountId: envelope.accountId,
          sync: envelopeSync,
        }
      : undefined,
  };
}

function syncFromEnvelope(envelope: LinkCompletionEnvelope | null): ServiceBinding["sync"] | undefined {
  if (!envelope) return undefined;
  return normalizeBindingSyncMetadata({
    serviceDomain: envelope.serviceDomain,
    nonceUrl: envelope.nonceUrl,
    verifyUrl: envelope.verifyUrl,
    statusUrl: envelope.statusUrl,
  });
}

function getProductState(phase: string, pass: boolean | undefined, hasRecovery: boolean) {
  if (phase === "proving" || phase === "measuring") {
    return {
      label: phase === "measuring" ? "MEASURING" : "VERIFYING",
      tone: C.text,
      detail: phase === "measuring" ? "Reading the latest 72-hour health window." : "Verifying the current device state.",
      accentBg: "#F5F5F2",
    };
  }

  if (hasRecovery || phase === "recovery_pending") {
    return {
      label: "RECOVERY NEEDED",
      tone: C.warn,
      detail: "This linked account needs recovery approval.",
      accentBg: "#FFF8EC",
    };
  }

  if (phase === "expired") {
    return {
      label: "EXPIRED",
      tone: C.error,
      detail: "Proof expired. Renew only if this device still qualifies.",
      accentBg: "#FFFFFF",
    };
  }

  if ((phase === "ready" || phase === "needs_renewal") && pass) {
    return {
      label: phase === "needs_renewal" ? "RENEW SOON" : "PASS",
      tone: phase === "needs_renewal" ? C.warn : C.success,
      detail: phase === "needs_renewal" ? "Refresh will be needed soon." : "This device is currently eligible.",
      accentBg: "#FFFFFF",
    };
  }

  return {
    label: "NOT READY",
    tone: phase === "error" ? C.error : C.warn,
    detail: phase === "not_ready" ? "The latest measurement did not pass." : "A check or connection is needed.",
    accentBg: "#FFFFFF",
  };
}

export default function App() {
  const presence = usePresenceState();
  const [rawLink, setRawLink] = useState("");
  const [openedEnvelope, setOpenedEnvelope] = useState<LinkCompletionEnvelope | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [showService, setShowService] = useState(false);
  const [scannerSupported, setScannerSupported] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [, setLog] = useState<string[]>([`[${nowTime()}] App started — platform: ${Platform.OS}`]);
  const [hydratedServiceBindings, setHydratedServiceBindings] = useState<ServiceBinding[]>([]);
  const [hydratingServiceBindings, setHydratingServiceBindings] = useState(false);
  const [serviceBindingsHydrationError, setServiceBindingsHydrationError] = useState<string | null>(null);
  const serviceScrollRef = useRef<ScrollView | null>(null);
  const [serviceViewportHeight, setServiceViewportHeight] = useState(0);
  const [serviceContentHeight, setServiceContentHeight] = useState(0);
  const [serviceScrollOffset, setServiceScrollOffset] = useState(0);

  const addLog = useCallback((msg: string) => {
    const line = `[${nowTime()}] ${msg}`;
    console.log(`[PresenceApp] ${line}`);
    setLog((prev) => [line, ...prev].slice(0, 40));
  }, []);

  const runMeasurementAndSync = useCallback(async (source: "manual" | "scheduled") => {
    const measurement = await presence.measure(
      source === "scheduled"
        ? { renewalAttempt: true }
        : undefined
    );
    if (!measurement) {
      addLog(source === "scheduled" ? "❌ Scheduled measurement failed" : "❌ Measurement failed");
      return null;
    }

    addLog(
      source === "scheduled"
        ? (
          measurement.pass
            ? "🔄 Scheduled renewal measurement passed"
            : `⚠️ Scheduled measurement reported NOT READY — ${measurement.reason}`
        )
        : (
          measurement.pass
            ? "✅ PASS measurement refreshed"
            : `⚠️ NOT READY — ${measurement.reason}`
        )
    );

    const syncResult = await syncLinkedBindings({ measurement });
    const refreshedState = source === "scheduled" || syncResult.attempted > 0 || syncResult.errors.length > 0
      ? (await presence.refresh()) ?? measurement.state
      : measurement.state;
    addLog(
      `   state: created=${refreshedState?.stateCreatedAt ?? '-'} validUntil=${refreshedState?.stateValidUntil ?? '-'} measured=${refreshedState?.lastMeasuredAt ?? '-'} phase=${refreshedState?.status ?? '-'}`
    );
    addLog(`↻ Synced bindings — verified ${syncResult.verified}, skipped ${syncResult.skipped}, attempted ${syncResult.attempted}`);
    if (measurement.pass && syncResult.attempted === 0 && (measurement.state?.serviceBindings.some(isActiveBinding) ?? false)) {
      addLog("   no linked binding selected for nonce/prove/verify");
    }
    for (const diagnosticLine of formatGroupedLogEntries("diagnostics", syncResult.diagnostics)) {
      addLog(`   ${diagnosticLine}`);
    }
    for (const errorLine of formatSyncErrorEntries(syncResult.errors)) {
      addLog(syncResult.errors.length > 0 ? `❌ ${errorLine}` : `   ${errorLine}`);
    }

    return { measurement, syncResult };
  }, [addLog, presence]);

  const runAutomaticRefresh = useCallback(async () => {
    const result = await runMeasurementAndSync("scheduled");
    if (!result) {
      addLog("❌ Automatic refresh finished without a measurement result");
      return false;
    }

    const success = result.measurement.pass && result.syncResult.errors.length === 0;
    addLog(
      `↻ Automatic refresh finished — pass=${result.measurement.pass} attempted=${result.syncResult.attempted} verified=${result.syncResult.verified} errors=${result.syncResult.errors.length}`
    );
    return success;
  }, [addLog, runMeasurementAndSync]);

  usePresenceRenewal(presence, runAutomaticRefresh);

  const localBindingsForHydration = useMemo(
    () => suppressShadowedLegacyUnsyncableBindings(
      mergeServiceBindings([...(presence.state?.serviceBindings ?? []), ...hydratedServiceBindings])
    ),
    [presence.state?.serviceBindings, hydratedServiceBindings]
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
    const hasLocalBindingsForDevice = persisted.serviceBindings.some((binding) => binding.linkedDeviceIss === deviceIss);
    if (recoveredBindings.length === 0 && hasLocalBindingsForDevice) return;
    const mergedState = mergeAuthoritativeServiceBindings(persisted, recoveredBindings);
    if (JSON.stringify(mergedState.serviceBindings) === JSON.stringify(persisted.serviceBindings)) {
      return;
    }
    await savePresenceState(mergedState);
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
      addLog("ℹ️ completion seed skipped — response did not include a complete binding record");
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

    setHydratedServiceBindings((current) => mergeServiceBindings([seededBinding, ...current]));
    await persistAuthoritativeBindings(seededBinding.linkedDeviceIss, [seededBinding]);
    addLog(`✅ completion seed persisted — binding=${seededBinding.bindingId} ${describeBindingSync(seededBinding.sync)}`);
    return { ok: true, seeded: true };
  }, [addLog, persistAuthoritativeBindings]);

  const activateEnvelope = useCallback(async (
    parsed: LinkCompletionEnvelope,
    source: "link" | "qr" | "system",
    rawUrl?: string
  ): Promise<boolean> => {
    setRawLink(rawUrl ?? buildPresenceLinkUrl(parsed));
    setShowConnection(true);
    const normalizedServiceDomain = debugNormalizeServiceDomain(parsed.serviceDomain);
    const envelopeSync = syncFromEnvelope(parsed);
    addLog(`🔎 ${source} parse session=${parsed.sessionId} service=${parsed.serviceId ?? "-"}`);
    addLog(
      `🔎 envelope boundary source=${source} flow=${parsed.flow ?? (parsed.bindingId ? "reauth" : "initial_link")} binding=${parsed.bindingId ?? "-"} ${describeBindingSync(envelopeSync)}`
    );
    addLog(`🔎 service_domain raw=${JSON.stringify(parsed.serviceDomain ?? null)} normalized=${JSON.stringify(normalizedServiceDomain)}`);
    addLog(`🔎 nonce_url=${parsed.nonceUrl ?? "-"}`);
    addLog(`🔎 verify_url=${parsed.verifyUrl ?? "-"}`);
    const trustValidation = await validateLinkCompletionEnvelope(parsed);
    if (!trustValidation.ok) {
      setOpenedEnvelope(null);
      setConnectionError(trustValidation.error.message);
      addLog(`❌ ${trustValidation.error.code} — ${trustValidation.error.message}`);
      console.log(`[PresenceTestApp] ❌ ${trustValidation.error.code} — ${trustValidation.error.message}`);
      return false;
    }

    setConnectionError(null);
    setOpenedEnvelope(parsed);
    addLog(`✅ trust validation passed for ${parsed.serviceId ?? "unknown-service"} on ${normalizedServiceDomain ?? "unknown-domain"}`);
    addLog(`${source === "qr" ? "📷" : source === "system" ? "🔗" : "📲"} Opened ${source} session ${parsed.sessionId}`);
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

  const hydrateAuthoritativeBindings = useCallback(async (deviceIss: string, source: string) => {
    setHydratingServiceBindings(true);
    setServiceBindingsHydrationError(null);
    try {
      const localBindings = localBindingsForHydrationRef.current;
      try {
        const deviceBindings = await fetchJson<DeviceBindingsResponse>(`https://noctu.link/presence-demo/presence/devices/${encodeURIComponent(deviceIss)}/bindings`);
        const recoveredBindings = preserveLocalBindingSyncMetadata(
          deviceBindings.bindings
          .filter((binding) => binding.deviceIss === deviceIss)
          .map((binding) => ({
            bindingId: binding.bindingId,
            serviceId: binding.serviceId,
            accountId: binding.accountId,
            linkedDeviceIss: binding.deviceIss,
            linkedAt: binding.lastLinkedAt ?? binding.createdAt ?? binding.updatedAt ?? Math.floor(Date.now() / 1000),
            lastVerifiedAt: binding.lastVerifiedAt,
            status: binding.status,
          })),
          localBindings,
          deviceIss
        );
        setHydratedServiceBindings(recoveredBindings);
        await persistAuthoritativeBindings(deviceIss, recoveredBindings);
        addLog(`↻ Recovered ${recoveredBindings.length} bindings from device endpoint (${source})`);
        return;
      } catch (deviceEndpointError) {
        addLog(`ℹ️ Device bindings endpoint unavailable (${source}) — ${deviceEndpointError instanceof Error ? deviceEndpointError.message : String(deviceEndpointError)}`);
      }

      const audit = await fetchJson<AuditEventsResponse>("https://noctu.link/presence-demo/presence/audit-events");
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
                const status = await fetchJson<LinkedAccountStatusResponse>(`https://noctu.link/presence-demo/presence/linked-accounts/${encodeURIComponent(accountId)}/status`);
                const binding = toServiceBindingFromStatus(status);
                return binding?.linkedDeviceIss === deviceIss ? binding : null;
              } catch {
                return null;
              }
            })
          )
        ).filter((binding): binding is ServiceBinding => !!binding),
        localBindings,
        deviceIss
      );

      setHydratedServiceBindings(recoveredBindings);
      await persistAuthoritativeBindings(deviceIss, recoveredBindings);
      addLog(`↻ Recovered ${recoveredBindings.length} bindings via audit fallback (${source})`);
    } catch (error) {
      setServiceBindingsHydrationError(error instanceof Error ? error.message : String(error));
      setHydratedServiceBindings([]);
    } finally {
      setHydratingServiceBindings(false);
    }
  }, [addLog, persistAuthoritativeBindings]);

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

  const proveOptions = useMemo(() => (openedEnvelope ? envelopeToProveOptions(openedEnvelope) : null), [openedEnvelope]);
  const effectiveServiceBindings = localBindingsForHydration;
  const hasRecovery = effectiveServiceBindings.some((binding) => binding.status === "recovery_pending" || binding.status === "reauth_required");
  const productState = getProductState(presence.phase, presence.state?.pass, hasRecovery);
  const openedSessionAlreadyLinked = !!(
    openedEnvelope?.serviceId
    && openedEnvelope?.accountId
    && effectiveServiceBindings.some((binding) => (
      binding.serviceId === openedEnvelope.serviceId
      && binding.accountId === openedEnvelope.accountId
      && binding.status === "linked"
    ))
  );
  const recentServiceBindings = [...effectiveServiceBindings]
    .filter((binding) => isActiveBinding(binding))
    .sort((a, b) => {
      const timeA = a.lastVerifiedAt ?? a.linkedAt ?? 0;
      const timeB = b.lastVerifiedAt ?? b.linkedAt ?? 0;
      return timeB - timeA;
    })
    .slice(0, 10);
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

  const clearConnectSession = useCallback(() => {
    setOpenedEnvelope(null);
    setRawLink("");
    setConnectionError(null);
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
    addLog(`✅ Link session ${parsed.sessionId} loaded — tap Approve to create a linked proof`);
  };

  const handleScanQr = async () => {
    setConnectionError(null);
    setOpenedEnvelope(null);
    setScannerBusy(true);
    try {
      const payload = await scanQrCode();
      setRawLink(payload);
      const parsed = parsePresenceLinkUrl(payload);
      if (!parsed) {
        setConnectionError("The QR code was read, but it is not a valid Presence link.");
        addLog(`❌ Scanned QR payload was not a Presence link — raw=${payload.slice(0, 180)}`);
        return;
      }
      await activateEnvelope(parsed, "qr", payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("cancelled")) {
        setConnectionError(message);
        addLog(`❌ QR scan failed — ${message}`);
      }
    } finally {
      setScannerBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!proveOptions) {
      setLocalError("Open a link session first.");
      return;
    }

    const currentEnvelope = openedEnvelope;
    if (openedSessionAlreadyLinked) {
      addLog("↩ Approve ignored — service/account is already linked in the current app state");
      return;
    }

    addLog(`→ approve ${proveOptions.flow ?? "initial_link"} session`);
    const payload = await presence.prove(proveOptions);
    if (!payload) {
      setLocalError(presence.error?.message ?? "Could not create the proof.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} — ${presence.error?.message ?? ""}`);
      return;
    }

    setLocalError(null);
    addLog("✅ Proof generated with link_context");
    addLog(`   link_session_id: ${payload.link_context?.link_session_id ?? "n/a"}`);
    addLog(`   binding_id: ${payload.link_context?.binding_id ?? "server-created"}`);

    const completionUrl = buildCompletionUrl(currentEnvelope);
    if (!completionUrl) {
      clearConnectSession();
      addLog("↗ No completion URL available; proof is ready but server completion was skipped");
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
        addLog(`❌ completion ${response.status} — ${truncateJson(parsed || raw, 600)}`);
        return;
      }

      const seedResult = await seedConfirmedBinding(parsed as CompletionSuccessResponse, currentEnvelope);
      if (!seedResult.ok) {
        setLocalError(seedResult.message);
        addLog(`❌ completion seed rejected — ${seedResult.message}`);
        addLog(`   response: ${truncateJson(parsed, 500)}`);
        return;
      }

      clearConnectSession();
      addLog(`✅ completion ${response.status} — binding saved on server${seedResult.seeded ? " and seeded locally" : ""}`);
      addLog(`   response: ${truncateJson(parsed, 500)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(`Could not reach the completion endpoint: ${message}`);
      addLog(`❌ completion network error — ${message}`);
      return;
    }
  };

  const handleMeasure = async () => {
    addLog("→ measure() — rolling 72h window");
    const result = await runMeasurementAndSync("manual");
    if (!result) {
      setLocalError(presence.error?.message ?? "Could not complete the measurement.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} — ${presence.error?.message ?? ""}`);
      return;
    }

    if (result.measurement.pass) {
      setLocalError(null);
      return;
    }

    setLocalError(result.measurement.reason);
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.screen}>
        <View style={styles.topRow}>
          <TouchableOpacity style={styles.qrButton} onPress={() => setShowConnection(true)} activeOpacity={0.85}>
            <Text style={styles.qrIcon}>⌁</Text>
          </TouchableOpacity>
          <View style={styles.topRightCompact}>
            <View style={[styles.statePill, styles.statePillLight, { borderColor: productState.tone }]}> 
              <View style={[styles.stateDot, { backgroundColor: productState.tone }]} />
              <Text style={[styles.stateLabel, { color: productState.tone }]}>{productState.label}</Text>
            </View>
            {!!presence.timeRemaining && <Text style={styles.topTime}>{presence.timeRemaining}</Text>}
          </View>
        </View>

        <View style={styles.heroCard}>
          <TouchableOpacity
            style={styles.heroImageWrap}
            onPress={openedEnvelope ? handleApprove : handleMeasure}
            disabled={presence.phase === "proving" || presence.phase === "measuring"}
            activeOpacity={0.9}
          >
            {(presence.phase === "proving" || presence.phase === "measuring")
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
                  Health access is required to create proof. Open App Settings for app permissions. If Health access is still off, open the Health app → Data Access & Devices → Presence, then allow read access for Heart Rate and Steps.
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
            <Text style={styles.bottomBarButtonText}>SERVICE</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={showService} transparent animationType="fade" onRequestClose={() => setShowService(false)}>
          <View style={styles.modalBackdrop}>
            <TouchableOpacity style={styles.modalBackdropPressable} onPress={() => setShowService(false)} activeOpacity={1} />
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.sectionTitle}>Service</Text>
                <TouchableOpacity onPress={() => setShowService(false)} activeOpacity={0.85}>
                  <Text style={styles.modalClose}>Close</Text>
                </TouchableOpacity>
              </View>

              {hydratingServiceBindings ? (
                <Text style={styles.modalMeta}>Syncing linked services…</Text>
              ) : serviceBindingsHydrationError ? (
                <Text style={styles.modalMeta}>Service sync fallback: {serviceBindingsHydrationError}</Text>
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
                        <KeyValue label="service" value={binding.serviceId} />
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
                  <Text style={styles.emptyBody}>Complete a /presence/link flow from your service to populate this list.</Text>
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

                  <View style={styles.connectionOptions}>
                    <View style={styles.optionCard}>
                      <Text style={styles.optionIcon}>⌗</Text>
                      <Text style={styles.optionTitle}>Scan QR</Text>
                      <Text style={styles.optionBody}>
                        {scannerSupported ? "Scan a Presence QR code with your camera." : "Direct scanning is not available on this device. Use the link below."}
                      </Text>
                      {scannerSupported ? (
                        <TouchableOpacity
                          style={[styles.secondaryButton, scannerBusy && styles.buttonDisabled]}
                          onPress={handleScanQr}
                          disabled={scannerBusy}
                          activeOpacity={0.85}
                        >
                          <Text style={styles.secondaryButtonText}>{scannerBusy ? "Preparing…" : "Scan QR"}</Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.optionPillMuted}>
                          <Text style={styles.optionPillText}>Requires a real iPhone</Text>
                        </View>
                      )}
                    </View>

                    <View style={styles.optionCard}>
                      <Text style={styles.optionIcon}>↗</Text>
                      <Text style={styles.optionTitle}>Load link session</Text>
                      <Text style={styles.optionBody}>Load a Presence link into this app, then approve to generate a proof.</Text>
                    </View>
                  </View>

                  {openedEnvelope && !openedSessionAlreadyLinked ? (
                    <View style={styles.loadedSessionCard}>
                      <Text style={styles.loadedSessionLabel}>Approve service session</Text>
                      <Text style={styles.loadedSessionBody}>
                        {openedSessionAlreadyLinked
                          ? "This service/account is already linked in the current app state. Load a fresh link if you want to re-approve."
                          : "Session loaded. Review the details below, then tap Approve to generate a proof for this service."}
                      </Text>
                      <View style={styles.loadedSessionMeta}>
                        <KeyValue label="Service" value={openedEnvelope.serviceId ?? "unknown"} />
                        <KeyValue label="Service domain" value={openedEnvelope.serviceDomain ?? "not supplied"} />
                        <KeyValue label="Session" value={openedEnvelope.sessionId} mono />
                        <KeyValue label="Flow" value={openedEnvelope.flow ?? "initial_link"} />
                        <KeyValue label="Code" value={openedEnvelope.code ?? "none"} mono />
                      </View>
                      <TouchableOpacity
                        style={[styles.primaryActionButton, presence.phase === "proving" && styles.buttonDisabled]}
                        onPress={handleApprove}
                        disabled={presence.phase === "proving"}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.primaryActionButtonText}>
                          {presence.phase === "proving" ? "Approving…" : "Approve service session"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.ghostButton}
                        onPress={() => {
                          setOpenedEnvelope(null);
                          setLocalError(null);
                          setRawLink("");
                        }}
                        activeOpacity={0.85}
                      >
                        <Text style={styles.ghostButtonText}>Load different session</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      <TextInput
                        style={styles.input}
                        value={rawLink}
                        onChangeText={(value) => {
                          setRawLink(value);
                          setConnectionError(null);
                          setOpenedEnvelope(null);
                        }}
                        placeholder="Paste a presence://link session here"
                        placeholderTextColor={C.subtext}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                      />

                      <TouchableOpacity style={styles.primaryActionButton} onPress={handleOpenLink} activeOpacity={0.85}>
                        <Text style={styles.primaryActionButtonText}>Load session</Text>
                      </TouchableOpacity>

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
  topRightCompact: {
    alignItems: "flex-end",
    gap: 8,
  },
  topTime: {
    color: C.subtext,
    fontSize: 12,
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
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  statePillLight: {
    backgroundColor: "#FFFFFF",
  },
  stateDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
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
    gap: 10,
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
    minHeight: 104,
    marginHorizontal: 18,
    marginTop: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    color: C.text,
    padding: 14,
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
    alignItems: "center",
    justifyContent: "center",
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
