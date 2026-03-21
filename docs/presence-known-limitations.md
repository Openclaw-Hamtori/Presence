# Presence known limitations

This document captures product and platform limitations that should be understood before public rollout.

---

## 1. iOS background execution is not a guaranteed scheduler

Presence on iOS can attempt background refresh behavior, but iOS does not provide a general-purpose guarantee that apps will run at exact times in the background.

Implications:
- background renewal can be best-effort
- exact periodic deadlines are not guaranteed
- app refresh timing is controlled by system heuristics
- short background execution windows may expire early

Recommended public wording:
- Presence attempts background refresh where platform conditions allow it
- Presence should not promise exact periodic renewal while backgrounded

---

## 2. Force-quit survival should not be treated as guaranteed

If the user force quits the app, iOS generally prevents background relaunch until the user opens it again.

Implications:
- do not promise automatic renewal after force quit
- design product UX around foreground-resume recovery
- document this clearly rather than implying unsupported behavior

---

## 3. App-local PASS is not sufficient authority

The mobile app can show PASS locally while the service backend still needs a fresh verified snapshot for the linked account.

Implications:
- service access should be gated by backend readiness
- app-local state is useful UX but not authoritative service truth

---

## 4. File-backed linkage storage is a reference persistence layer

The SDK includes a hardened filesystem-backed linkage store, but it is still a file-backed reference adapter.

Implications:
- suitable for development, reference deployments, and controlled environments
- long-term production deployments may prefer a stronger transactional store
- persistence correctness remains part of product correctness

---

## 5. Background success and guaranteed freshness are different goals

Presence may succeed in many background cases, especially with platform-specific triggers like HealthKit delivery, but that is still different from guaranteeing exact freshness windows under all lifecycle conditions.

Implications:
- document best-effort background behavior honestly
- use server-side readiness and freshness windows explicitly
- keep foreground-resume recovery fast and reliable

---

## 6. Unlink semantics should be documented clearly

Presence service bindings are not necessarily hard-deleted immediately from backend history.
A service may represent unlink as a binding that remains in history with `status: "unlinked"`.

Implications:
- readiness should treat `unlinked` as not connected
- app UI should stop showing the service as an active connected card after authoritative hydration
- public docs should distinguish current active connection state from historical binding records

---

## 7. Public docs should avoid over-claiming

Avoid claims like:
- "Presence always renews in the background"
- "Presence survives force quit automatically"
- "The app alone decides whether the user is valid"

Prefer claims like:
- "Presence uses fresh proofs and backend readiness"
- "Background refresh is best-effort on iOS"
- "Server-side readiness is authoritative for access decisions"
