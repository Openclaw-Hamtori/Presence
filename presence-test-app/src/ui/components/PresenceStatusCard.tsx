// INTENTIONAL_FORK: test app keeps a shorter validation hint because no persistent request context is needed.
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
  const hasServiceRequest = !!state?.activeLinkSession;
  const hasLocalMeasurement = !!state?.lastMeasuredAt;

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

  const hasLocalPass = !!state?.pass
    && phase !== "not_ready"
    && phase !== "error"
    && phase !== "recovery_pending";
  const hasFailingLocalResult = !!hasLocalMeasurement
    && !hasLocalPass
    && phase !== "measuring"
    && phase !== "proving"
    && phase !== "uninitialized";
  const statusLabel = phase === "recovery_pending" || phase === "error" || hasFailingLocalResult
    ? "FAIL"
    : "IDLE";
  const topRightText = phase === "recovery_pending"
    ? "Recovery needed"
    : phase === "proving"
      ? "Verifying request"
      : phase === "measuring"
        ? hasServiceRequest
          ? "Checking request"
          : "Local-only check"
        : hasServiceRequest
          ? hasLocalPass
            ? "Request ready"
            : hasLocalMeasurement
              ? "Request blocked"
              : "Request loaded"
          : hasLocalPass
            ? "No active request"
            : hasLocalMeasurement
              ? "Local check failed"
              : "No active request";
  const isFailStatus = statusLabel === "FAIL";

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.iconChip} activeOpacity={0.8}>
          <Text style={styles.iconText}>⌁</Text>
        </TouchableOpacity>

        <View style={styles.topRight}>
          <View style={[styles.badge, isFailStatus ? styles.badgeFail : styles.badgeWarn]}>
            <Text style={[styles.badgeText, isFailStatus ? styles.badgeTextFail : styles.badgeTextWarn]}>{statusLabel}</Text>
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

        {phase === "proving" && (
          <>
            <Text style={styles.helper}>
              Presence is submitting proof. PASS is reserved for server-verified success.
            </Text>
          </>
        )}

        {hasServiceRequest && phase !== "proving" && (
          <>
            <Text style={styles.helper}>
              {phase === "measuring"
                ? "Checking this device for the active request. The service still needs to verify any proof that follows."
                : hasLocalPass
                  ? "A local check passed for the active request, but nothing is server-verified yet."
                  : phase === "recovery_pending"
                    ? "A linked service needs recovery or relink before proof can be accepted."
                    : "A service request is loaded. Run a local check, then submit proof."}
            </Text>
            {phase !== "measuring" && hasLocalPass && (
              <TouchableOpacity style={styles.primaryButton} onPress={handleSubmitProof}>
                <Text style={styles.primaryButtonText}>Submit proof</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {((hasServiceRequest && !hasLocalPass && phase !== "measuring" && phase !== "recovery_pending")
          || (!hasServiceRequest && phase !== "proving" && phase !== "uninitialized")) && (
          <>
            <Text style={styles.helper}>
              {hasServiceRequest
                ? "PASS is unavailable for this request until a fresh local check succeeds."
                : phase === "measuring"
                  ? "Running a local-only check. This does not create PASS or notify a server."
                  : hasLocalPass
                    ? "Latest local-only check passed on device, but no request is active and nothing has been server-verified."
                    : hasLocalMeasurement
                      ? "Latest local-only check did not qualify. No request is active and nothing was sent to a server."
                      : "No active request. Load a service request before submitting proof."}
            </Text>
            {phase !== "measuring" && (
              <TouchableOpacity style={styles.primaryButton} onPress={handleMeasure}>
                <Text style={styles.primaryButtonText}>{hasServiceRequest ? "Run local check" : "Run local-only check"}</Text>
              </TouchableOpacity>
            )}
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
  warn: "#B07B1A",
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
  badgeWarn: {
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
  badgeTextWarn: {
    color: COLORS.warn,
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
