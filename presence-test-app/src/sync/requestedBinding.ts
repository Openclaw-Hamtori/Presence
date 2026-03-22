import type { LinkCompletionEnvelope } from "../deeplink";
import { mergeBindingSyncMetadata, normalizeBindingSyncMetadata } from "../state/bindingSync.ts";
import type { ServiceBinding } from "../types/index";

function inferEnvelopeFlow(envelope: LinkCompletionEnvelope): NonNullable<LinkCompletionEnvelope["flow"]> | "initial_link" {
  return envelope.flow ?? (envelope.bindingId ? "reauth" : "initial_link");
}

function isLinkedBinding(binding: ServiceBinding): boolean {
  return binding.status === "linked";
}

export function syncFromEnvelope(
  envelope: LinkCompletionEnvelope | null
): ServiceBinding["sync"] | undefined {
  if (!envelope) return undefined;
  return normalizeBindingSyncMetadata({
    serviceDomain: envelope.serviceDomain,
    nonceUrl: envelope.nonceUrl,
    verifyUrl: envelope.verifyUrl,
    statusUrl: envelope.statusUrl,
    pendingRequestsUrl: envelope.pendingRequestsUrl,
  });
}

export function resolveRequestedLinkedBinding(
  envelope: LinkCompletionEnvelope | null,
  bindings: ServiceBinding[]
): ServiceBinding | null {
  if (!envelope) return null;

  const flow = inferEnvelopeFlow(envelope);
  if (flow === "relink" || flow === "recovery") {
    return null;
  }

  const matchingBinding = (
    envelope.bindingId
      ? bindings.find((binding) => binding.bindingId === envelope.bindingId && isLinkedBinding(binding))
      : undefined
  ) ?? (
    envelope.serviceId && envelope.accountId
      ? bindings.find((binding) => (
        binding.serviceId === envelope.serviceId
        && binding.accountId === envelope.accountId
        && isLinkedBinding(binding)
      ))
      : undefined
  );

  if (!matchingBinding) {
    return null;
  }

  return {
    ...matchingBinding,
    sync: mergeBindingSyncMetadata(matchingBinding.sync, syncFromEnvelope(envelope)),
  };
}
