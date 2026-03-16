# Product Boundaries

## Presence
Presence is an independent product and protocol.
Its app, SDK, verifier, whitepaper, and user-facing language must stay internally consistent.
Presence is about device-based human presence verification using PASS / FAIL semantics.

## Noctu
Noctu is a separate product/service layer.
It may consume Presence proofs or integrate with Presence flows, but it must not overwrite Presence app identity, onboarding language, root UI, or whitepaper semantics.

## Operating rule
- Do not place Noctu branding, owl/wizard framing, or Noctu product copy inside Presence root app surfaces.
- If Noctu needs Presence, connect through service sessions, proofs, deeplinks, or integration docs — not by rewriting the Presence app into Noctu.
- Before release, verify that Presence app/UI copy, SDK docs, and whitepaper all describe the same independent Presence product.
