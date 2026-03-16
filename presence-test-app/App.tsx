import React, { useCallback, useEffect, useMemo, useState } from "react";
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
} from "react-native";
import { usePresenceState } from "./src/ui/usePresenceState";
import { usePresenceRenewal } from "./src/ui/usePresenceRenewal";
import { clearPresenceState } from "./src/state/presenceState";
import { uint8ArrayToBase64url } from "./src/crypto/index";
import { readBiometricWindow } from "./src/health/healthkit";
import { buildPresenceLinkUrl, parsePresenceLinkUrl } from "./src/deeplink";
import type { LinkCompletionEnvelope } from "./src/deeplink";
import { getBackgroundRefreshDiagnostics } from "./src/backgroundRefresh";
import type { BackgroundRefreshDiagnostics } from "./src/backgroundRefresh";
import type { LinkFlow, PresenceTransportPayload, ServiceBinding } from "./src/types/index";
import type { ProveOptions } from "./src/service";
import { isQrScannerSupported, scanQrCode } from "./src/qrScanner";
import { getInitialPresenceLink, subscribeToPresenceLinks } from "./src/ui/connectionLinking";
import { syncLinkedBindings } from "./src/sync/linkedBindings";
import { loadLinkedBindingSyncJobs, clearLinkedBindingSyncQueue } from "./src/sync/queue";

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

function generateLocalNonce(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return uint8ArrayToBase64url(bytes);
}

function nowTime(): string {
  return new Date().toISOString().slice(11, 19);
}

function truncateJson(obj: unknown, maxLen = 1400): string {
  const full = JSON.stringify(obj, null, 2);
  if (full.length <= maxLen) return full;
  return `${full.slice(0, maxLen)}\n  …(truncated)`;
}

function formatEpoch(epoch?: number): string {
  if (!epoch || epoch <= 0) return "none";
  return new Date(epoch * 1000).toLocaleString();
}

function formatFinish(diagnostics: BackgroundRefreshDiagnostics | null): string {
  if (!diagnostics?.lastFinishedAt || diagnostics.lastFinishedAt <= 0) {
    return "none";
  }
  const suffix = diagnostics.lastFinishedSuccess == null
    ? ""
    : diagnostics.lastFinishedSuccess
      ? " (success)"
      : " (failed)";
  return `${new Date(diagnostics.lastFinishedAt * 1000).toLocaleString()}${suffix}`;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDemoEnvelope(flow: LinkFlow = "initial_link"): LinkCompletionEnvelope {
  const serviceId = "presence-demo";
  const bindingId = flow === "initial_link" ? undefined : randomId("pbind");
  return {
    sessionId: randomId("plink"),
    serviceId,
    accountId: "demo-user",
    bindingId,
    flow,
    method: "deeplink",
    nonce: generateLocalNonce(),
    returnUrl: "presence://complete",

    code: Math.random().toString(36).slice(2, 8).toUpperCase(),
  };
}

function envelopeToProveOptions(envelope: LinkCompletionEnvelope): ProveOptions | null {
  if (!envelope.nonce) return null;
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
        sync: {
          nonceUrl: envelope.nonceUrl,
          verifyUrl: envelope.verifyUrl,
          statusUrl: envelope.statusUrl,
        },
      },
    },
    bindingHint: envelope.bindingId
      ? {
          bindingId: envelope.bindingId,
          serviceId: envelope.serviceId ?? "presence-demo",
          accountId: envelope.accountId,
          sync: {
            nonceUrl: envelope.nonceUrl,
            verifyUrl: envelope.verifyUrl,
            statusUrl: envelope.statusUrl,
          },
        }
      : undefined,
  };
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

  if ((phase === "ready" || phase === "needs_renewal" || phase === "expired") && pass) {
    return {
      label: phase === "needs_renewal" ? "RENEW SOON" : "PASS",
      tone: C.success,
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

function getBindingSummary(bindings: ServiceBinding[]) {
  if (bindings.some((binding) => binding.status === "recovery_pending" || binding.status === "reauth_required")) {
    return {
      tone: C.warn,
      title: "복구 필요",
      detail: "기존 연결과 다른 기기이거나 다시 인증이 필요해.",
    };
  }
  if (bindings.some((binding) => binding.status === "linked")) {
    return {
      tone: C.success,
      title: "연결됨",
      detail: "이 기기에 연결된 서비스 계정이 있어.",
    };
  }
  if (bindings.some((binding) => binding.status === "revoked" || binding.status === "unlinked")) {
    return {
      tone: C.warn,
      title: "연결 해제됨",
      detail: "서비스에서 다시 연결 세션을 열어야 해.",
    };
  }
  return {
    tone: C.subtext,
    title: "연결 없음",
    detail: "아직 서비스 계정과 묶이지 않았어.",
  };
}

function getConnectionStatus(params: {
  openedEnvelope: LinkCompletionEnvelope | null;
  lastPayload: PresenceTransportPayload | null;
  bindings: ServiceBinding[];
}) {
  const { openedEnvelope, lastPayload, bindings } = params;
  const activeBinding = openedEnvelope?.bindingId
    ? bindings.find((binding) => binding.bindingId === openedEnvelope.bindingId)
    : bindings.find((binding) => binding.serviceId === (openedEnvelope?.serviceId ?? ""));

  if (activeBinding?.status === "recovery_pending" || activeBinding?.status === "reauth_required") {
    return {
      label: "복구 필요",
      tone: C.warn,
      background: "#2a2418",
      detail: "이 계정은 복구 또는 재연결 승인이 필요해.",
    };
  }

  if (activeBinding?.status === "linked" && !openedEnvelope) {
    return {
      label: "연결 완료",
      tone: C.success,
      background: "#103028",
      detail: "바인딩이 저장된 상태야. 이제 linked account 검증 단계로 갈 수 있어.",
    };
  }

  if (lastPayload?.link_context?.link_session_id && openedEnvelope?.sessionId === lastPayload.link_context.link_session_id) {
    return {
      label: "승인 완료",
      tone: C.success,
      background: "#103028",
      detail: "이 세션으로 proof가 만들어졌어. 서버 completion 단계만 남았어.",
    };
  }

  if (openedEnvelope) {
    return {
      label: "승인 대기",
      tone: C.accent,
      background: C.accentSoft,
      detail: "세션을 열었어. 아래 인증 버튼을 누르면 현재 기기 proof를 만들 수 있어.",
    };
  }

  return {
    label: "세션 없음",
    tone: C.subtext,
    background: C.surfaceSoft,
    detail: "QR을 스캔하거나 링크를 열면 연결 상태가 여기 표시돼.",
  };
}

function buildJourneySteps(params: {
  openedEnvelope: LinkCompletionEnvelope | null;
  lastPayload: PresenceTransportPayload | null;
  bindings: ServiceBinding[];
}) {
  const { openedEnvelope, lastPayload, bindings } = params;
  const activeBinding = openedEnvelope?.bindingId
    ? bindings.find((binding) => binding.bindingId === openedEnvelope.bindingId)
    : bindings.find((binding) => binding.serviceId === (openedEnvelope?.serviceId ?? ""));

  const steps = [
    {
      key: "opened",
      title: "1. 세션 열림",
      detail: openedEnvelope ? `session ${openedEnvelope.sessionId}` : "QR 또는 링크를 기다리는 중",
      state: openedEnvelope ? "done" : "current",
    },
    {
      key: "approve",
      title: "2. 승인 준비",
      detail: openedEnvelope ? "이 기기에서 인증 버튼을 누르면 돼" : "세션이 열리면 바로 승인 가능",
      state: openedEnvelope ? (lastPayload ? "done" : "current") : "todo",
    },
    {
      key: "proof",
      title: "3. proof 생성",
      detail: lastPayload?.link_context?.link_session_id ? "link_context 포함 payload 생성됨" : "아직 서버로 보낼 proof 없음",
      state: lastPayload?.link_context?.link_session_id ? "done" : "todo",
    },
    {
      key: "binding",
      title: "4. 연결 상태",
      detail: activeBinding?.status === "linked"
        ? "binding saved"
        : activeBinding?.status === "recovery_pending" || activeBinding?.status === "reauth_required"
          ? "recovery needed"
          : "server completion 이후 linked 로 전환",
      state: activeBinding?.status === "linked" ? "done" : activeBinding ? "current" : "todo",
    },
  ] as const;

  return steps;
}

export default function App() {
  const presence = usePresenceState();
  const [lastPayload, setLastPayload] = useState<PresenceTransportPayload | null>(null);
  const [rawLink, setRawLink] = useState("");
  const [openedEnvelope, setOpenedEnvelope] = useState<LinkCompletionEnvelope | null>(null);
  const demoFlow: LinkFlow = "initial_link";
  const [localError, setLocalError] = useState<string | null>(null);
  const [showConnection, setShowConnection] = useState(false);
  const [showService, setShowService] = useState(false);
  const [showDevTools, setShowDevTools] = useState(false);
  const [scannerSupported, setScannerSupported] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [log, setLog] = useState<string[]>([`[${nowTime()}] App started — platform: ${Platform.OS}`]);
  const [pendingSyncJobs, setPendingSyncJobs] = useState(0);
  const [bgDiagnostics, setBgDiagnostics] = useState<BackgroundRefreshDiagnostics | null>(null);

  const addLog = useCallback((msg: string) => {
    setLog((prev) => [`[${nowTime()}] ${msg}`, ...prev].slice(0, 40));
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    const [jobs, diagnostics] = await Promise.all([
      loadLinkedBindingSyncJobs(),
      getBackgroundRefreshDiagnostics(),
    ]);
    setPendingSyncJobs(jobs.length);
    setBgDiagnostics(diagnostics);
  }, []);

  const runAutomaticRefresh = useCallback(async () => {
    const measurement = await presence.measure();
    if (!measurement) {
      addLog("❌ Scheduled measurement failed");
      await refreshDiagnostics();
      return false;
    }

    addLog(
      measurement.pass
        ? "🔄 Background measurement refreshed PASS state"
        : `⚠️ Background measurement reported NOT READY — ${measurement.reason}`
    );

    const syncResult = await syncLinkedBindings({ measurement });
    if (syncResult.attempted > 0) {
      addLog(`↻ Synced bindings — verified ${syncResult.verified}, skipped ${syncResult.skipped}`);
    }
    for (const syncError of syncResult.errors.slice(0, 3)) {
      addLog(`❌ ${syncError.bindingId}: ${syncError.message}`);
    }

    await refreshDiagnostics();
    return syncResult.errors.length === 0;
  }, [addLog, presence, refreshDiagnostics]);

  usePresenceRenewal(presence, runAutomaticRefresh);

  const activateEnvelope = useCallback((parsed: LinkCompletionEnvelope, source: "link" | "qr" | "system") => {
    setOpenedEnvelope(parsed);
    setRawLink(buildPresenceLinkUrl(parsed));
    setShowConnection(true);
    setLocalError(null);
    addLog(`${source === "qr" ? "📷" : source === "system" ? "🔗" : "📲"} Opened ${source} session ${parsed.sessionId}`);
  }, [addLog]);

  useEffect(() => {
    LogBox.ignoreAllLogs();
    isQrScannerSupported().then(setScannerSupported).catch(() => setScannerSupported(false));
    void refreshDiagnostics();

    getInitialPresenceLink().then((initialEnvelope) => {
      if (initialEnvelope) activateEnvelope(initialEnvelope, "system");
    }).catch(() => undefined);

    return subscribeToPresenceLinks((envelope) => {
      activateEnvelope(envelope, "system");
    });
  }, [activateEnvelope, refreshDiagnostics]);

  useEffect(() => {
    void refreshDiagnostics();
  }, [presence.state?.stateValidUntil, presence.state?.nextMeasurementAt, presence.phase, refreshDiagnostics]);

  const parsedFromEditor = useMemo(() => parsePresenceLinkUrl(rawLink), [rawLink]);
  const proveOptions = useMemo(() => (openedEnvelope ? envelopeToProveOptions(openedEnvelope) : null), [openedEnvelope]);
  const hasRecovery = presence.state?.serviceBindings?.some((binding) => binding.status === "recovery_pending" || binding.status === "reauth_required") ?? false;
  const productState = getProductState(presence.phase, presence.state?.pass, hasRecovery);
  const activeSession = openedEnvelope;
  const stateMeta = [
    presence.timeRemaining ? `유효 ${presence.timeRemaining}` : null,
    presence.state?.lastSignals?.length ? `신호 ${presence.state.lastSignals.join(", ")}` : null,
    presence.state?.serviceBindings?.length ? `연결 ${presence.state.serviceBindings.length}` : null,
    presence.state?.nextMeasurementAt ? `다음 측정 ${new Date(presence.state.nextMeasurementAt * 1000).toLocaleTimeString()}` : null,
    pendingSyncJobs > 0 ? `재시도 ${pendingSyncJobs}` : null,
  ].filter(Boolean) as string[];
  const bindingSummary = getBindingSummary(presence.state?.serviceBindings ?? []);
  const connectionStatus = getConnectionStatus({
    openedEnvelope,
    lastPayload,
    bindings: presence.state?.serviceBindings ?? [],
  });
  const journeySteps = buildJourneySteps({
    openedEnvelope,
    lastPayload,
    bindings: presence.state?.serviceBindings ?? [],
  });

  const handlePermissions = async () => {
    addLog("→ requestPermissions()");
    const granted = await presence.requestPermissions();
    addLog(granted ? "✅ HealthKit permission granted" : "❌ Permission denied or error");
    if (!granted && presence.error) addLog(`   ${presence.error.code}: ${presence.error.message}`);
  };

  const handleGenerateSession = () => {
    const envelope = createDemoEnvelope(demoFlow);
    setRawLink(buildPresenceLinkUrl(envelope));
    setOpenedEnvelope(null);
    setLastPayload(null);
    setLocalError(null);
    addLog(`🧾 Service created ${demoFlow} session ${envelope.sessionId}`);
    addLog("↗ 링크를 열면 이 세션을 현재 기기에 연결할 수 있어");
  };

  const handleOpenLink = () => {
    const parsed = parsePresenceLinkUrl(rawLink);
    if (!parsed) {
      setLocalError("유효한 Presence 링크가 아니야. presence://link 형식 세션 링크를 넣어줘.");
      addLog("❌ Invalid deeplink payload");
      return;
    }
    Keyboard.dismiss();
    setLocalError(null);
    activateEnvelope(parsed, "link");
    addLog(`✅ Link session ${parsed.sessionId} loaded — 이제 Approve를 눌러 연결 proof를 만들 수 있어`);
  };

  const handleScanQr = async () => {
    setLocalError(null);
    setScannerBusy(true);
    try {
      const payload = await scanQrCode();
      setRawLink(payload);
      const parsed = parsePresenceLinkUrl(payload);
      if (!parsed) {
        setLocalError("QR은 읽었지만 Presence 연결 링크 형식이 아니야.");
        addLog("❌ Scanned QR payload was not a Presence link");
        return;
      }
      activateEnvelope(parsed, "qr");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("cancelled")) {
        setLocalError(message);
        addLog(`❌ QR scan failed — ${message}`);
      }
    } finally {
      setScannerBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!proveOptions) {
      setLocalError("먼저 연결 링크를 열어줘.");
      return;
    }

    addLog(`→ approve ${proveOptions.flow ?? "initial_link"} session`);
    const payload = await presence.prove(proveOptions);
    if (payload) {
      setLastPayload(payload);
      setLocalError(null);
      setShowConnection(false);
      addLog("✅ Proof generated with link_context");
      addLog(`   link_session_id: ${payload.link_context?.link_session_id ?? "n/a"}`);
      addLog(`   binding_id: ${payload.link_context?.binding_id ?? "server-created"}`);
      addLog("↗ 이제 서버가 session completion API로 이 payload를 받아 binding을 저장하면 돼");
    } else {
      setLocalError(presence.error?.message ?? "인증을 생성하지 못했어.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} — ${presence.error?.message ?? ""}`);
    }
    await refreshDiagnostics();
  };

  const handleMeasure = async () => {
    addLog("→ measure() — rolling 72h window");
    const measurement = await presence.measure();
    if (!measurement) {
      setLocalError(presence.error?.message ?? "측정을 완료하지 못했어.");
      addLog(`❌ ${presence.error?.code ?? "unknown"} — ${presence.error?.message ?? ""}`);
      return;
    }

    if (measurement.pass) {
      setLocalError(null);
      addLog("✅ PASS measurement refreshed");
      await refreshDiagnostics();
      return;
    }

    setLocalError(measurement.reason);
    addLog(`⚠️ NOT READY — ${measurement.reason}`);
    await syncLinkedBindings({ measurement });
    await refreshDiagnostics();
  };

  const handleReset = async () => {
    addLog("→ clearPresenceState()");
    await clearPresenceState();
    await clearLinkedBindingSyncQueue();
    presence.clearError();
    setLastPayload(null);
    setOpenedEnvelope(null);
    setRawLink("");
    setLocalError(null);
    setShowConnection(false);
    addLog("✅ State cleared — re-launch to re-onboard");
    await refreshDiagnostics();
  };

  const handleDiagnose = async () => {
    addLog("→ readBiometricWindow() [diagnostic]");
    const result = await readBiometricWindow();
    if (!result.ok) {
      addLog(`❌ ${result.error.code}: ${result.error.message}`);
      return;
    }
    const w = result.value;
    const totalDuration = w.bpmSamples.reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const dayMap: Record<string, { count: number; bucketSet: Set<number> }> = {};
    for (const s of w.bpmSamples) {
      const date = new Date(s.timestamp * 1000);
      const dayKey = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
      if (!dayMap[dayKey]) dayMap[dayKey] = { count: 0, bucketSet: new Set<number>() };
      dayMap[dayKey].count += 1;
      dayMap[dayKey].bucketSet.add(Math.floor(s.timestamp / 600));
    }
    addLog(`   samples: ${w.bpmSamples.length} totalDur: ${totalDuration}s`);
    addLog(`   days with HR: ${Object.keys(dayMap).length}`);
    for (const [dayKey, value] of Object.entries(dayMap)) {
      const steps = w.stepsByDay[dayKey] ?? 0;
      addLog(`   ${dayKey}: ${value.count} samples, ${value.bucketSet.size} x 10m buckets, ${steps} steps`);
    }
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
            <Text style={styles.errorCode}>{presence.error?.code ?? "PRESENCE"}</Text>
            <Text style={styles.errorMsg}>{localError ?? presence.error?.message}</Text>
          </View>
        )}

        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.bottomBarButton} onPress={() => setShowService(true)} activeOpacity={0.85}>
            <Text style={styles.bottomBarButtonText}>SERVICE</Text>
          </TouchableOpacity>
        </View>

        <Modal visible={showService} transparent animationType="fade" onRequestClose={() => setShowService(false)}>
          <TouchableWithoutFeedback onPress={() => setShowService(false)}>
            <View style={styles.modalBackdrop}>
              <TouchableWithoutFeedback>
                <View style={styles.modalCard}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.sectionTitle}>Service</Text>
                    <TouchableOpacity onPress={() => setShowService(false)} activeOpacity={0.85}>
                      <Text style={styles.modalClose}>Close</Text>
                    </TouchableOpacity>
                  </View>

                  {(presence.state?.serviceBindings ?? []).length > 0 ? (
                    <View style={styles.bindingList}>
                      {presence.state?.serviceBindings.map((binding) => (
                        <View key={binding.bindingId} style={styles.bindingCard}>
                          <KeyValue label="service" value={binding.serviceId} />
                          <KeyValue label="status" value={binding.status} />
                          {binding.accountId ? <KeyValue label="account" value={binding.accountId} /> : null}
                        </View>
                      ))}
                    </View>
                  ) : (
                    <View style={styles.bindingBanner}>
                      <Text style={[styles.bindingTitle, { color: bindingSummary.tone }]}>-</Text>
                    </View>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>

        <Modal visible={showConnection} transparent animationType="fade" onRequestClose={() => setShowConnection(false)}>
          <TouchableWithoutFeedback
            onPress={() => {
              Keyboard.dismiss();
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

                  {openedEnvelope ? (
                    <View style={styles.loadedSessionCard}>
                      <Text style={styles.loadedSessionLabel}>Approve service session</Text>
                      <Text style={styles.loadedSessionBody}>
                        Session loaded. Review the details below, then tap Approve to generate a proof for this service.
                      </Text>
                      <View style={styles.loadedSessionMeta}>
                        <KeyValue label="Service" value={openedEnvelope.serviceId ?? "unknown"} />
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
                          setLastPayload(null);
                          setLocalError(null);
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
                        onChangeText={setRawLink}
                        placeholder="Paste a presence://link session here"
                        placeholderTextColor={C.subtext}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                      />

                      <TouchableOpacity style={styles.primaryActionButton} onPress={handleOpenLink} activeOpacity={0.85}>
                        <Text style={styles.primaryActionButtonText}>Load session</Text>
                      </TouchableOpacity>
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
  bindingList: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 12,
  },
  bindingCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceSoft,
    overflow: "hidden",
  },
  emptyBody: {
    color: C.subtext,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 18,
    paddingBottom: 18,
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
