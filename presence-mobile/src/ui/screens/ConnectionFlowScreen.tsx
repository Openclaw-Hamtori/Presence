import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { ProveOptions } from "../../service";
import type { LinkFlow, PresenceTransportPayload } from "../../types/index";
import { buildPresenceLinkUrl, parsePresenceLinkUrl } from "../../deeplink";
import type { LinkCompletionEnvelope } from "../../deeplink";
import { validateLinkCompletionEnvelope } from "../../linkTrust";
import type { UsePresenceStateResult } from "../usePresenceState";

interface MockLinkServiceSession {
  sessionId: string;
  serviceId: string;
  serviceDomain: string;
  accountId?: string;
  bindingId?: string;
  flow: LinkFlow;
  nonce: string;
  recoveryCode?: string;
  returnUrl?: string;
}

interface ConnectionFlowScreenProps {
  presence: UsePresenceStateResult;
  createMockSession?: () => Promise<MockLinkServiceSession>;
  onProofGenerated?: (payload: PresenceTransportPayload) => void;
}

const DEMO_SERVICE_DOMAIN = "demo.presence.local";

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function randomNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let value = "";
  for (let i = 0; i < 43; i += 1) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
}

async function defaultCreateMockSession(): Promise<MockLinkServiceSession> {
  const sessionId = randomId("plink");
  const serviceId = "presence-demo";
  return {
    sessionId,
    serviceId,
    serviceDomain: DEMO_SERVICE_DOMAIN,
    accountId: "demo-user",
    bindingId: undefined,
    flow: "initial_link",
    nonce: randomNonce(),
    recoveryCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
    returnUrl: "presence://complete",
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
          serviceDomain: envelope.serviceDomain,
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
            serviceDomain: envelope.serviceDomain,
            nonceUrl: envelope.nonceUrl,
            verifyUrl: envelope.verifyUrl,
            statusUrl: envelope.statusUrl,
          },
        }
      : undefined,
  };
}

export function ConnectionFlowScreen({
  presence,
  createMockSession = defaultCreateMockSession,
  onProofGenerated,
}: ConnectionFlowScreenProps) {
  const [rawLink, setRawLink] = useState("");
  const [session, setSession] = useState<MockLinkServiceSession | null>(null);
  const [envelope, setEnvelope] = useState<LinkCompletionEnvelope | null>(null);
  const [proof, setProof] = useState<PresenceTransportPayload | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const nextEnvelope: LinkCompletionEnvelope = {
      sessionId: session.sessionId,
      serviceId: session.serviceId,
      serviceDomain: session.serviceDomain,
      accountId: session.accountId,
      bindingId: session.bindingId,
      flow: session.flow,
      method: "deeplink",
      nonce: session.nonce,
      returnUrl: session.returnUrl,
      code: session.recoveryCode,
    };
    setEnvelope(null);
    setRawLink(buildPresenceLinkUrl(nextEnvelope));
  }, [session]);

  const parsedEnvelope = useMemo(() => parsePresenceLinkUrl(rawLink), [rawLink]);
  const proveOptions = useMemo(() => (envelope ? envelopeToProveOptions(envelope) : null), [envelope]);

  const handleCreateSession = async () => {
    setLocalError(null);
    setProof(null);
    setEnvelope(null);
    const next = await createMockSession();
    setSession(next);
  };

  const handleOpenLink = async () => {
    setLocalError(null);
    const parsed = parsePresenceLinkUrl(rawLink);
    if (!parsed) {
      setLocalError("Invalid Presence link. Expected presence://link?... payload.");
      return;
    }
    const trustValidation = await validateLinkCompletionEnvelope(parsed);
    if (!trustValidation.ok) {
      setEnvelope(null);
      setLocalError(trustValidation.error.message);
      return;
    }
    setEnvelope(parsed);
  };

  const handleApprove = async () => {
    setLocalError(null);
    const options = proveOptions;
    if (!options) {
      setLocalError("Open a valid service request before submitting proof.");
      return;
    }

    const granted = await presence.requestPermissions();
    if (!granted) {
      setLocalError(presence.error?.message ?? "Health permissions are required before submitting proof.");
      return;
    }

    const payload = await presence.prove(options);
    if (!payload) {
      setLocalError(presence.error?.message ?? "Could not generate proof for this session.");
      return;
    }

    setProof(payload);
    onProofGenerated?.(payload);
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Link Once, Then Submit PASS</Text>
        <Text style={styles.subtitle}>
          Simulates the product flow: service links Presence once, later asks for PASS when needed, and the app submits proof back to the service.
        </Text>

        <Card title="1. Service creates a link or PASS request">
          <PrimaryButton label="Create demo session" onPress={handleCreateSession} />
          {session && (
            <View style={styles.metaList}>
              <Meta label="Session" value={session.sessionId} mono />
              <Meta label="Service" value={session.serviceId} />
              <Meta label="Service domain" value={session.serviceDomain} mono />
              <Meta label="Flow" value={session.flow} />
              <Meta label="Binding" value={session.bindingId ?? "created after first link"} mono />
            </View>
          )}
        </Card>

        <Card title="2. QR/deeplink payload">
          <Text style={styles.small}>Use this string as the QR payload or open it directly as a deeplink.</Text>
          <TextInput
            style={styles.input}
            value={rawLink}
            onChangeText={(value) => {
              setRawLink(value);
              setEnvelope(null);
              setLocalError(null);
            }}
            placeholder="presence://link?session_id=..."
            placeholderTextColor="#777"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <View style={styles.row}>
            <SecondaryButton label="Simulate open" onPress={handleOpenLink} />
          </View>
        </Card>

        <Card title="3. Review on device">
          {parsedEnvelope ? (
            <View style={styles.metaList}>
              <Meta label="Session" value={parsedEnvelope.sessionId} mono />
              <Meta label="Service domain" value={parsedEnvelope.serviceDomain ?? "not supplied"} mono />
              <Meta label="Flow" value={parsedEnvelope.flow ?? "initial_link"} />
              <Meta label="Method" value={parsedEnvelope.method ?? "deeplink"} />
              <Meta label="Return URL" value={parsedEnvelope.returnUrl ?? "not supplied"} mono />
              <Meta label="Recovery code" value={parsedEnvelope.code ?? "not supplied"} mono />
            </View>
          ) : (
            <Text style={styles.empty}>Open a valid request to preview the device proof sheet.</Text>
          )}
        </Card>

        <Card title="4. Submit PASS on this device">
          <Text style={styles.small}>
            Presence requests Health access if needed, evaluates PASS, creates attestation, and attaches `link_context` so the service can link or verify the request.
          </Text>
          <PrimaryButton
            label={presence.phase === "proving" ? "Submitting PASS…" : "Submit PASS"}
            onPress={handleApprove}
            disabled={!proveOptions || presence.phase === "proving"}
          />
          {presence.phase === "proving" && <ActivityIndicator style={styles.loader} color="#7c6af7" />}
          {(localError || presence.error) && (
            <Text style={styles.error}>{localError ?? presence.error?.message}</Text>
          )}
          {proof && (
            <View style={styles.successBox}>
              <Text style={styles.successTitle}>Proof ready for the service</Text>
              <Text style={styles.successText}>Send this payload back to the service so it can finish the link or verify the request at:</Text>
              <Text style={styles.code}>{proof.link_context?.completion?.return_url ?? parsedEnvelope?.returnUrl ?? "service callback / completion endpoint"}</Text>
              <Text style={styles.small}>link_session_id={proof.link_context?.link_session_id ?? "n/a"}</Text>
              <Text style={styles.small}>binding_id={proof.link_context?.binding_id ?? "created server-side"}</Text>
            </View>
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity style={[styles.primaryButton, disabled && styles.buttonDisabled]} onPress={onPress} disabled={disabled}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.secondaryButton} onPress={onPress}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f" },
  scroll: { padding: 20, gap: 16, paddingBottom: 40 },
  title: { color: "#f0f0f0", fontSize: 28, fontWeight: "700" },
  subtitle: { color: "#9a9a9a", lineHeight: 22 },
  card: { backgroundColor: "#1a1a1a", borderRadius: 14, padding: 16, gap: 12 },
  cardTitle: { color: "#f0f0f0", fontSize: 16, fontWeight: "600" },
  small: { color: "#9a9a9a", fontSize: 13, lineHeight: 18 },
  input: {
    minHeight: 110,
    borderRadius: 12,
    backgroundColor: "#121212",
    borderColor: "#2d2d2d",
    borderWidth: 1,
    color: "#f0f0f0",
    padding: 12,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", gap: 10 },
  primaryButton: {
    backgroundColor: "#7c6af7",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: { color: "white", fontWeight: "600", fontSize: 15 },
  secondaryButton: {
    backgroundColor: "#26263a",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: "center",
  },
  secondaryButtonText: { color: "#d8d8ff", fontWeight: "600" },
  buttonDisabled: { opacity: 0.45 },
  metaList: { gap: 8 },
  metaRow: { gap: 4 },
  metaLabel: { color: "#8a8a8a", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  metaValue: { color: "#f0f0f0", lineHeight: 20 },
  mono: { fontFamily: "Menlo" },
  empty: { color: "#777" },
  loader: { marginTop: 8 },
  error: { color: "#ff8f8f", lineHeight: 20 },
  successBox: { backgroundColor: "#102318", borderRadius: 12, padding: 12, gap: 8 },
  successTitle: { color: "#baf0ca", fontWeight: "700" },
  successText: { color: "#d4ead8", lineHeight: 20 },
  code: { color: "#c8d3ff", fontFamily: "Menlo", fontSize: 12 },
});
