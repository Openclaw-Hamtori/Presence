import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
} from "react-native";
import type { UsePresenceStateResult, PresenceHookPhase } from "../usePresenceState";

const ORB_IMAGE = require("../assets/presence-orb.png");

interface PresenceStatusCardProps {
  presence: UsePresenceStateResult;
  onProve?: (nonce: string) => void;
  fetchNonce: () => Promise<string>;
}

export function PresenceStatusCard({ presence, fetchNonce }: PresenceStatusCardProps) {
  const { phase, state, error, timeRemaining, needsRenewal } = presence;

  const handleRenew = async () => {
    try {
      const nonce = await fetchNonce();
      await presence.prove(nonce);
    } catch {}
  };

  const handleMeasure = async () => {
    try {
      await presence.measure();
    } catch {}
  };

  const statusLabel = phase === "needs_renewal" ? "RENEW" : state?.pass ? "PASS" : phase === "not_ready" ? "FAIL" : "PRESENCE";
  const topRightText = state?.pass ? timeRemaining ?? "" : phase === "not_ready" ? "Measure again" : "";

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.iconChip} activeOpacity={0.8}>
          <Text style={styles.iconText}>⌁</Text>
        </TouchableOpacity>

        <View style={styles.topRight}>
          <View style={[styles.badge, statusLabel === "FAIL" && styles.badgeFail, statusLabel === "RENEW" && styles.badgeRenew]}>
            <Text style={[styles.badgeText, statusLabel === "FAIL" && styles.badgeTextFail, statusLabel === "RENEW" && styles.badgeTextRenew]}>{statusLabel}</Text>
          </View>
          {!!topRightText && <Text style={styles.topMeta}>{topRightText}</Text>}
        </View>
      </View>

      <View style={styles.heroWrap}>
        {(phase === "loading" || phase === "measuring" || phase === "proving") && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator color={COLORS.text} />
          </View>
        )}
        <Image source={ORB_IMAGE} style={styles.heroImage} resizeMode="contain" />
      </View>

      <View style={styles.bottomArea}>
        {phase === "uninitialized" && <Text style={styles.helper}>No proof yet</Text>}

        {(phase === "ready" || phase === "needs_renewal" || phase === "proving") && state && (
          <>
            <Text style={styles.helper}>{state.lastMeasurementReason ?? "Presence active"}</Text>
            {needsRenewal && phase !== "proving" && (
              <TouchableOpacity style={styles.primaryButton} onPress={handleRenew}>
                <Text style={styles.primaryButtonText}>Renew proof</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {phase === "expired" && (
          <>
            <Text style={styles.helper}>Proof expired</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleRenew}>
              <Text style={styles.primaryButtonText}>Generate new proof</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === "not_ready" && (
          <>
            <Text style={styles.helper}>Latest measurement is not ready</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleMeasure}>
              <Text style={styles.primaryButtonText}>Measure again</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === "error" && error && (
          <>
            <Text style={[styles.helper, styles.errorText]}>{error.message}</Text>
            <TouchableOpacity onPress={presence.clearError}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

function phaseColor(phase: PresenceHookPhase): string {
  switch (phase) {
    case "ready": return COLORS.success;
    case "needs_renewal": return COLORS.warning;
    case "not_ready":
    case "expired":
    case "error": return COLORS.error;
    default: return COLORS.subtext;
  }
}

const COLORS = {
  bg: "#FAFAF7",
  text: "#1B1B18",
  subtext: "#8C8C84",
  border: "#E8E7E1",
  success: "#2F7D4A",
  warning: "#B07B1A",
  error: "#A94A4A",
  chip: "rgba(255,255,255,0.72)",
};

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 28,
    justifyContent: "space-between",
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: COLORS.chip,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: {
    fontSize: 16,
    color: COLORS.text,
  },
  topRight: {
    alignItems: "flex-end",
    gap: 8,
  },
  badge: {
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "rgba(47,125,74,0.08)",
  },
  badgeFail: {
    backgroundColor: "rgba(169,74,74,0.08)",
  },
  badgeRenew: {
    backgroundColor: "rgba(176,123,26,0.08)",
  },
  badgeText: {
    color: COLORS.success,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  badgeTextFail: {
    color: COLORS.error,
  },
  badgeTextRenew: {
    color: COLORS.warning,
  },
  topMeta: {
    color: COLORS.subtext,
    fontSize: 12,
  },
  heroWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    marginTop: 12,
  },
  heroImage: {
    width: "56%",
    height: "56%",
    minWidth: 200,
    minHeight: 200,
  },
  loadingOverlay: {
    position: "absolute",
    top: "50%",
    zIndex: 1,
  },
  bottomArea: {
    alignItems: "center",
    gap: 12,
    minHeight: 72,
  },
  helper: {
    color: COLORS.subtext,
    fontSize: 12,
    textAlign: "center",
  },
  errorText: {
    color: COLORS.error,
  },
  primaryButton: {
    marginTop: 2,
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 18,
    backgroundColor: COLORS.text,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
  },
  dismissText: {
    color: COLORS.subtext,
    fontSize: 12,
  },
});
