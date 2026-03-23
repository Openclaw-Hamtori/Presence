/**
 * presence-verifier
 * Presence Attestation Verifier — Reference Implementation
 *
 * Based on:
 *   - Presence Signal Spec v0.4
 *   - Presence Verifier Spec v0.4
 *   - Presence Android Platform Appendix v0.1
 */

export { verify } from "./verifier.js";
export type { VerifierContext } from "./verifier.js";

export {
  InMemoryNonceStore,
  InMemoryTofuStore,
  SqliteTofuStore,
  SQLITE_TOFU_SCHEMA,
} from "./stores.js";

export type {
  PresenceAttestation,
  PresenceSignal,
  PresenceSignals,
  VerifierInput,
  VerifierResult,
  VerifierSuccess,
  VerifierFailure,
  ServicePolicy,
  NonceStore,
  TofuStore,
  Platform,
  PresenceErrorCode,
  DeviceAttestationResult,
  IosClaims,
  AndroidClaims,
} from "./types.js";

export type { SqliteTofuStoreOptions } from "./stores.js";

export { PresenceVerifierError } from "./types.js";

export { jcsSerialize, getSigningInput, sha256Hex, deriveIss } from "./crypto.js";
export { verifyAppleAttestation, verifyPlayIntegrityToken, resolveTofuPublicKey, verifyAttestationDigest } from "./attestation.js";
