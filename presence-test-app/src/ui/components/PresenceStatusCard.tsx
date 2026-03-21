import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
} from "react-native";
import type { UsePresenceStateResult } from "../usePresenceState";

const ORB_IMAGE = require("../assets/presence-orb.png");

interface PresenceStatusCardProps {
  presence: UsePresenceStateResult;
  onProve?: (nonce: string) => void;
  fetchNonce: () => Promise<string>;
}

export function PresenceStatusCard({ presence, fetchNonce }: PresenceStatusCardProps) {
  const { phase, state, error } = presence;
  const [actionError, setActionError] = React.useState<string | null>(null);
  const visibleErrorMessage = actionError ?? error?.message ?? null;

  const handleSubmitProof = async () => {
    setActionError(null);
    presence.clearError();
    try {
      const nonce = await fetchNonce();
      await presence.prove(nonce);
    } catch (caughtError) {
      setActionError(toErrorMessage(caughtError));
    }
  };

  const handleMeasure = async () => {
    setActionError(null);
    presence.clearError();
    try {
      await presence.measure();
    } catch (caughtError) {
      setActionError(toErrorMessage(caughtError));
    }
  };

  const hasPass = !!state?.pass
    && phase !== "not_ready"
    && phase !== "error"
    && phase !== "recovery_pending";
  const statusLabel = hasPass ? "PASS" : "FAIL";
  const topRightText = phase === "proving"
    ? "Submitting PASS"
    : phase === "measuring"
      ? "Checking device"
      : hasPass
        ? "Ready for request"
        : phase === "recovery_pending"
          ? "Recovery needed"
          : "";

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.iconChip} activeOpacity={0.8}>
          <Text style={styles.iconText}>⌁</Text>
        </TouchableOpacity>

        <View style={styles.topRight}>
          <View style={[styles.badge, statusLabel === "FAIL" && styles.badgeFail]}>
            <Text style={[styles.badgeText, statusLabel === "FAIL" && styles.badgeTextFail]}>{statusLabel}</Text>
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
        {phase === "uninitialized" && <Text style={styles.helper}>Open a service link to connect Presence.</Text>}

        {hasPass && state && (
          <>
            <Text style={styles.helper}>
              {phase === "proving"
                ? "Submitting PASS to the current service request."
                : "PASS is ready to submit when a linked service asks."}
            </Text>
            {phase !== "proving" && (
              <TouchableOpacity style={styles.primaryButton} onPress={handleSubmitProof}>
                <Text style={styles.primaryButtonText}>Submit PASS</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {(phase === "not_ready" || phase === "recovery_pending") && (
          <>
            <Text style={styles.helper}>
              {phase === "recovery_pending"
                ? "A linked service needs recovery or relink before proof can be accepted."
                : "PASS is unavailable right now. Run a local check before submitting proof."}
            </Text>
            <TouchableOpacity style={styles.primaryButton} onPress={handleMeasure}>
              <Text style={styles.primaryButtonText}>Run local check</Text>
            </TouchableOpacity>
          </>
        )}

        {visibleErrorMessage && (
          <>
            <Text style={[styles.helper, styles.errorText]}>{visibleErrorMessage}</Text>
            <TouchableOpacity onPress={() => {
              setActionError(null);
              presence.clearError();
            }}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const COLORS = {
  bg: "#FAFAF7",
  text: "#1B1B18",
  subtext: "#8C8C84",
  border: "#E8E7E1",
  success: "#2F7D4A",
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
  badgeText: {
    color: COLORS.success,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  badgeTextFail: {
    color: COLORS.error,
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
