export type ProductStateTone = "success" | "warn" | "error";
export type RequestedProofUiStatus = "submitting" | "failed" | "expired";

function formatLinkedServiceLabel(count: number): string {
  if (count === 0) return "No linked services";
  return `${count} linked service${count === 1 ? "" : "s"}`;
}

function formatProductSummary(params: {
  linkedServiceCount: number;
  requestState: "active" | "verifying" | "verified" | "expired" | "none";
}): string {
  const linkedSummary = formatLinkedServiceLabel(params.linkedServiceCount);
  if (params.requestState === "verifying") return `Verifying request · ${linkedSummary}`;
  if (params.requestState === "verified") return `Recently verified · ${linkedSummary}`;
  if (params.requestState === "active") return `Active request · ${linkedSummary}`;
  if (params.requestState === "expired") return `Expired request · ${linkedSummary}`;
  return `No active request · ${linkedSummary}`;
}

export function buildRequestedProofKey(params: {
  requestId?: string | null;
  sessionId?: string | null;
  bindingId?: string | null;
  serviceId?: string | null;
  accountId?: string | null;
}): string | null {
  const primaryId = params.requestId ?? params.sessionId;
  if (!primaryId) return null;

  return [
    primaryId,
    params.bindingId ?? "-",
    params.serviceId ?? "-",
    params.accountId ?? "-",
  ].join(":");
}

export function getProductState(params: {
  phase: string;
  pass: boolean | undefined;
  hasLocalMeasurement?: boolean;
  hasRecovery: boolean;
  linkedServiceCount: number;
  requestedServiceId?: string | null;
  requestedProofStatus?: RequestedProofUiStatus | null;
  recentVerifiedServiceId?: string | null;
  connectedServiceId?: string | null;
  hasActionableRequestedProof?: boolean;
}) {
  const {
    phase,
    pass,
    hasLocalMeasurement,
    hasRecovery,
    linkedServiceCount,
    requestedServiceId,
    requestedProofStatus,
    recentVerifiedServiceId,
    connectedServiceId,
    hasActionableRequestedProof = true,
  } = params;
  const hasActionableRequest = hasActionableRequestedProof;
  const requestSummary = requestedServiceId ? ` for ${requestedServiceId}` : "";
  const hasLocalPass = !!pass && phase !== "not_ready" && phase !== "error" && !hasRecovery;
  const noRequestSummary = formatProductSummary({
    linkedServiceCount,
    requestState: "none",
  });

  if (connectedServiceId) {
    return {
      label: "CONNECTED!",
      tone: "success" as const,
      heading: `Linked to ${connectedServiceId}`,
      detail: "Presence linked successfully and is ready for service requests.",
      action: "This CONNECTED! label is shown briefly, then returns to IDLE.",
      summary: noRequestSummary,
    };
  }

  if (requestedServiceId && hasActionableRequest && requestedProofStatus === "submitting") {
    return {
      label: "IDLE",
      tone: "warn" as const,
      heading: "Submitting proof",
      detail: `Presence is submitting proof${requestSummary}. PASS is reserved for server-verified success.`,
      action: "Keep the app open while the service verifies the proof.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: "verifying",
      }),
    };
  }

  if (requestedServiceId && hasActionableRequest && requestedProofStatus === "failed") {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Proof request failed",
      detail: `The latest proof attempt${requestSummary} did not complete server verification.`,
      action: "Tap Submit proof to retry with a fresh local check.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: "active",
      }),
    };
  }

  if (requestedServiceId && hasActionableRequest && requestedProofStatus === "expired") {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Request expired",
      detail: `The latest request${requestSummary} expired before Presence could finish verification.`,
      action: "Open a fresh service request, then submit proof again.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: "expired",
      }),
    };
  }

  if (hasRecovery || phase === "recovery_pending") {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Recovery required",
      detail: "A linked service needs recovery or relink before it can accept proof from this device.",
      action: "Open the next service request to relink this device.",
      summary: noRequestSummary,
    };
  }

  if (!requestedServiceId && recentVerifiedServiceId) {
    const verifiedSummary = recentVerifiedServiceId ? ` for ${recentVerifiedServiceId}` : "";
    return {
      label: "PASS",
      tone: "success" as const,
      heading: "PASS verified",
      detail: `Presence just completed server verification${verifiedSummary}. No active request remains.`,
      action: "This PASS signal stays visible briefly, then returns to IDLE.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: "verified",
      }),
    };
  }

  if (phase === "measuring") {
    if (requestedServiceId) {
      return {
        label: "IDLE",
        tone: "warn" as const,
        heading: "Checking this device",
        detail: `Presence is running a local on-device check${requestSummary}. This only prepares proof and does not mean the server verified PASS.`,
        action: "Keep the app open while the local check completes.",
        summary: formatProductSummary({
          linkedServiceCount,
          requestState: "active",
        }),
      };
    }

    return {
      label: "IDLE",
      tone: "warn" as const,
      heading: "No active request",
      detail: "Presence is running a local-only check. Nothing from this check is being submitted or server-verified.",
      action: "Open the service link flow, or open Presence to hydrate pending proof requests when one is waiting.",
      summary: noRequestSummary,
    };
  }

  if (phase === "proving") {
    return {
      label: "IDLE",
      tone: "warn" as const,
      heading: requestedServiceId ? "Submitting proof" : "Creating proof",
      detail: requestedServiceId
        ? `Presence is submitting proof${requestSummary}. PASS is reserved for server-verified success.`
        : "Presence is creating proof for the current request. The service still needs to verify it.",
      action: "Keep the app open while the proof round-trip completes.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: requestedServiceId ? "verifying" : "active",
      }),
    };
  }

  if (requestedServiceId) {
    if (hasLocalPass) {
      return {
        label: "IDLE",
        tone: "warn" as const,
        heading: "Ready to submit proof",
        detail: `A local check passed${requestSummary}, but nothing is server-verified yet.`,
        action: "Tap the orb to submit proof to the requesting service.",
        summary: formatProductSummary({
          linkedServiceCount,
          requestState: "active",
        }),
      };
    }

    if (!hasLocalMeasurement && phase !== "error") {
      return {
        label: "IDLE",
        tone: "warn" as const,
        heading: "Request loaded",
        detail: `A service request${requestSummary} is active, but this device has not completed a fresh local check yet.`,
        action: "Tap the orb to run a local check before submitting proof.",
        summary: formatProductSummary({
          linkedServiceCount,
          requestState: "active",
        }),
      };
    }

    return {
      label: "FAIL",
      tone: phase === "error" ? "error" as const : "warn" as const,
      heading: "Proof request blocked",
      detail: `This request cannot be answered until this device passes a fresh local check${requestSummary}.`,
      action: "Tap the orb to run a local check for this request.",
      summary: formatProductSummary({
        linkedServiceCount,
        requestState: "active",
      }),
    };
  }

  if (hasLocalPass) {
    return {
      label: "IDLE",
      tone: "warn" as const,
      heading: "No active request",
      detail: linkedServiceCount > 0
        ? "The latest on-device check passed locally, but no linked service is currently asking for proof and nothing has been server-verified."
        : "The latest on-device check passed locally, but no request is loaded and nothing has been server-verified.",
      action: linkedServiceCount > 0
        ? "Open Presence to hydrate a pending request, or load a new link if needed."
        : "Open Presence (or link flow) when proof is needed.",
      summary: noRequestSummary,
    };
  }

  if (phase === "error") {
    return {
      label: "FAIL",
      tone: "error" as const,
      heading: "Presence error",
      detail: "Presence could not complete the latest local check. No request was active, and nothing was server-verified.",
      action: "Retry the local-only check, or open Presence to hydrate any pending service request.",
      summary: noRequestSummary,
    };
  }

  if (hasLocalMeasurement) {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Local check failed",
      detail: "The latest local-only check did not qualify, and nothing was submitted to a server.",
      action: linkedServiceCount > 0
        ? "Open Presence to hydrate a pending request, then run a fresh local check."
        : "Open the service link flow when you have a service link or proof request.",
      summary: noRequestSummary,
    };
  }

  return {
    label: "IDLE",
    tone: "warn" as const,
    heading: "No active request",
    detail: linkedServiceCount > 0
      ? "Presence is linked, but no service is currently asking for proof."
      : "Open Connect to start a link or wait for a service request.",
    action: linkedServiceCount > 0
      ? "Open Presence to hydrate linked service requests."
      : "Open Connect to start a link from your service.",
    summary: noRequestSummary,
  };
}
