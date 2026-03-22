export type ProductStateTone = "success" | "warn" | "error";
export type RequestedProofUiStatus = "submitting" | "failed";

function formatLinkedServiceLabel(count: number): string {
  if (count === 0) return "No linked services";
  return `${count} linked service${count === 1 ? "" : "s"}`;
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
  hasRecovery: boolean;
  linkedServiceCount: number;
  requestedServiceId?: string | null;
  requestedProofStatus?: RequestedProofUiStatus | null;
}) {
  const {
    phase,
    pass,
    hasRecovery,
    linkedServiceCount,
    requestedServiceId,
    requestedProofStatus,
  } = params;
  const linkedSummary = formatLinkedServiceLabel(linkedServiceCount);
  const requestSummary = requestedServiceId ? ` for ${requestedServiceId}` : "";
  const hasPass = !!pass && phase !== "not_ready" && phase !== "error" && !hasRecovery;

  if (requestedServiceId && requestedProofStatus === "submitting") {
    return {
      label: "CHECK",
      tone: "warn" as const,
      heading: "Submitting proof",
      detail: `Presence is submitting proof${requestSummary}. PASS is shown only after the service verifies it.`,
      action: "Keep the app open while the service verifies the proof.",
      summary: linkedSummary,
    };
  }

  if (requestedServiceId && requestedProofStatus === "failed") {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Proof request failed",
      detail: `The latest proof attempt${requestSummary} did not complete server verification.`,
      action: "Tap Submit PASS to retry with a fresh local check.",
      summary: linkedSummary,
    };
  }

  if (phase === "measuring") {
    return {
      label: hasPass ? "PASS" : "FAIL",
      tone: (hasPass ? "success" : "warn") as ProductStateTone,
      heading: "Checking this device",
      detail: "Presence is running a local on-device check to determine PASS or FAIL.",
      action: "Keep the app open while the local check completes.",
      summary: linkedSummary,
    };
  }

  if (phase === "proving") {
    return {
      label: hasPass ? "PASS" : "FAIL",
      tone: (hasPass ? "success" : "warn") as ProductStateTone,
      heading: requestedServiceId ? "Submitting proof" : "Creating proof",
      detail: requestedServiceId
        ? `Presence is submitting PASS${requestSummary}.`
        : "Presence is creating a proof for the current request.",
      action: "The service will verify the proof before allowing the action.",
      summary: linkedSummary,
    };
  }

  if (hasRecovery || phase === "recovery_pending") {
    return {
      label: "FAIL",
      tone: "warn" as const,
      heading: "Recovery required",
      detail: "A linked service needs recovery or relink before it can accept proof from this device.",
      action: "Open the next service request to relink this device.",
      summary: linkedSummary,
    };
  }

  if (hasPass) {
    return {
      label: "PASS",
      tone: "success" as const,
      heading: requestedServiceId ? "Proof request ready" : "Presence is linked",
      detail: requestedServiceId
        ? `This device is ready to submit PASS${requestSummary}.`
        : linkedServiceCount > 0
          ? "Presence keeps your linked services connected and submits proof only when one asks."
          : "This device currently has PASS and can be linked to a service from a deeplink or QR.",
      action: requestedServiceId
        ? "Tap the orb to submit PASS to the requesting service."
        : linkedServiceCount > 0
          ? "Open a service request when proof is needed."
          : "Open Connect to scan a QR or load a service link.",
      summary: linkedSummary,
    };
  }

  return {
    label: "FAIL",
    tone: phase === "error" ? "error" as const : "warn" as const,
    heading: requestedServiceId ? "Proof request blocked" : "Presence is not ready",
    detail: requestedServiceId
      ? `This request cannot be submitted until this device returns PASS${requestSummary}.`
      : linkedServiceCount > 0
        ? "Linked services stay connected, but proof is blocked until this device returns PASS."
        : "Open a service deeplink or QR to start linking Presence, then run a local check when PASS is needed.",
    action: requestedServiceId
      ? "Tap the orb to run a new local check."
      : linkedServiceCount > 0
        ? "Tap the orb to run a local check."
        : "Open Connect to start a link from your service.",
    summary: linkedSummary,
  };
}
