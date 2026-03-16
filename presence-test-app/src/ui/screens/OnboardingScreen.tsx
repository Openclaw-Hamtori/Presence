/**
 * presence-mobile — Onboarding Screen
 *
 * Presence onboarding flow — Mobile Client Flow v0.4.
 *
 * Steps:
 *   1. Welcome   — explain what Presence does
 *   2. Heartbeat — explain smartwatch requirement + HealthKit permission
 *   3. Prove    — first proof generation
 *   4. Done     — state established
 */

import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  Platform,
} from "react-native";
import type { UsePresenceStateResult } from "../usePresenceState";

// ─── Step definitions ─────────────────────────────────────────────────────────

type OnboardingStep = "welcome" | "heartbeat" | "prove" | "done";

interface OnboardingScreenProps {
  presence: UsePresenceStateResult;
  /** Called when onboarding is complete */
  onComplete: () => void;
  /** Service nonce — must be fetched from service before calling prove */
  fetchNonce: () => Promise<string>;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function OnboardingScreen({
  presence,
  onComplete,
  fetchNonce,
}: OnboardingScreenProps) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleHealthKitPermission = async () => {
    const granted = await presence.requestPermissions();
    if (granted) setStep("prove");
  };

  const handleProve = async () => {
    setLocalError(null);
    try {
      const nonce = await fetchNonce();
      const payload = await presence.prove(nonce);
      if (payload) {
        setStep("done");
      } else {
        setLocalError(presence.error?.message ?? "Proof failed. Please try again.");
      }
    } catch (e) {
      setLocalError("Could not connect to service. Check your connection.");
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {step === "welcome" && (
        <WelcomeStep onNext={() => setStep("heartbeat")} />
      )}
      {step === "heartbeat" && (
        <HeartbeatStep
          onGrant={handleHealthKitPermission}
          isLoading={presence.phase === "proving"}
        />
      )}
      {step === "prove" && (
        <ProveStep
          onProve={handleProve}
          isLoading={presence.phase === "proving"}
          error={localError}
        />
      )}
      {step === "done" && (
        <DoneStep onComplete={onComplete} />
      )}
    </SafeAreaView>
  );
}

// ─── Step: Welcome ────────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <View style={styles.step}>
      <Text style={styles.emoji}>💓</Text>
      <Text style={styles.title}>Prove you're human with Presence</Text>
      <Text style={styles.body}>
        Presence proves you're human using your heartbeat — no account, no server,
        no data ever leaves your device.
      </Text>
      <Text style={styles.subtext}>
        You'll need a smartwatch paired with your iPhone.
      </Text>
      <PrimaryButton label="Get started" onPress={onNext} />
    </View>
  );
}

// ─── Step: Heartbeat ──────────────────────────────────────────────────────────

function HeartbeatStep({
  onGrant,
  isLoading,
}: {
  onGrant: () => void;
  isLoading: boolean;
}) {
  return (
    <View style={styles.step}>
      <Text style={styles.emoji}>❤️</Text>
      <Text style={styles.title}>Share your heartbeat</Text>
      <Text style={styles.body}>
        Presence reads recent heart rate data from Apple Health to confirm you're
        present. Only a pass or fail result is computed — raw BPM values are
        never sent anywhere.
      </Text>
      <Text style={styles.subtext}>
        Tap Allow when iOS asks for Health access.
      </Text>
      {isLoading ? (
        <ActivityIndicator style={styles.loader} color={COLORS.accent} />
      ) : (
        <PrimaryButton label="Allow Health access" onPress={onGrant} />
      )}
    </View>
  );
}

// ─── Step: Prove ──────────────────────────────────────────────────────────────

function ProveStep({
  onProve,
  isLoading,
  error,
}: {
  onProve: () => void;
  isLoading: boolean;
  error: string | null;
}) {
  return (
    <View style={styles.step}>
      <Text style={styles.emoji}>🔐</Text>
      <Text style={styles.title}>Establishing your proof</Text>
      <Text style={styles.body}>
        Your device will generate a unique key and prove its integrity using
        Apple's App Attest. This takes a few seconds.
      </Text>
      {error && <Text style={styles.errorText}>{error}</Text>}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Generating proof…</Text>
        </View>
      ) : (
        <PrimaryButton label="Generate proof" onPress={onProve} />
      )}
    </View>
  );
}

// ─── Step: Done ───────────────────────────────────────────────────────────────

function DoneStep({
  onComplete,
}: {
  onComplete: () => void;
}) {
  return (
    <View style={styles.step}>
      <Text style={styles.emoji}>✅</Text>
      <Text style={styles.title}>You're human</Text>
      <Text style={styles.body}>
        Your Presence proof is active for 72 hours. Services that support Presence can
        verify you're human without knowing who you are.
      </Text>
      <View style={styles.statusBadge}>
        <Text style={styles.statusLabel}>Status</Text>
        <Text style={styles.statusValue}>PASS</Text>
        <Text style={styles.statusHint}>Linked and ready</Text>
      </View>
      <PrimaryButton label="Continue" onPress={onComplete} />
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.buttonDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const COLORS = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  accent: "#7c6af7",
  text: "#f0f0f0",
  subtext: "#888",
  error: "#e05c5c",
  success: "#4caf84",
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  step: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 20,
  },
  emoji: {
    fontSize: 64,
    marginBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: COLORS.text,
    textAlign: "center",
    lineHeight: 34,
  },
  body: {
    fontSize: 16,
    color: COLORS.subtext,
    textAlign: "center",
    lineHeight: 24,
  },
  subtext: {
    fontSize: 13,
    color: COLORS.subtext,
    textAlign: "center",
    opacity: 0.7,
  },
  button: {
    marginTop: 16,
    backgroundColor: COLORS.accent,
    paddingVertical: 16,
    paddingHorizontal: 48,
    borderRadius: 14,
    alignItems: "center",
    width: "100%",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    color: COLORS.error,
    fontSize: 14,
    textAlign: "center",
  },
  loadingContainer: {
    alignItems: "center",
    gap: 12,
    marginTop: 16,
  },
  loadingText: {
    color: COLORS.subtext,
    fontSize: 14,
  },
  loader: {
    marginTop: 16,
  },
  statusBadge: {
    alignItems: "center",
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    gap: 4,
  },
  statusLabel: {
    color: COLORS.subtext,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  statusValue: {
    color: COLORS.text,
    fontSize: 40,
    fontWeight: "800",
  },
  statusHint: {
    color: COLORS.success,
    fontSize: 14,
    fontWeight: "600",
  },
});
