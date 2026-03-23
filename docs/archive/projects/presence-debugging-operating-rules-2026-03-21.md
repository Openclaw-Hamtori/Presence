# Presence / service-app debugging operating rules — 2026-03-21

## Why this note exists

This note captures a costly failure pattern from the 2026-03-21 Presence debugging session so it does not repeat.

The failure was not only technical. It was operational:
- app-side symptoms were patched repeatedly
- server/service-side truth was not checked early enough
- partial evidence was over-weighted
- multiple incremental edits increased regression risk
- time and token cost grew
- user fatigue accumulated
- yet the real problem stayed unresolved until much later

---

## Critical correction to prior interpretation

The user's instruction was misunderstood.

### What the user did **not** mean
The user did **not** mean:
- "make only a very small code change"
- "prefer the tiniest patch even when root cause is unclear"
- "avoid larger fixes by repeatedly trying local edits"

### What the user **did** mean
The user meant:
- find the correct root cause first
- investigate properly before editing
- then make the correct fix, even if it is not the smallest textual diff
- reduce repeated patch cycles, regression risk, token burn, and human fatigue

So the correct principle is **not** "minimal change first".
The correct principle is:

> **Root-cause-first investigation, then the smallest complete fix that actually matches the real cause.**

---

## The specific failure pattern

Observed anti-pattern:
1. symptom seen in app UI
2. local/UI explanation selected too early
3. 1st patch applied
4. issue persists
5. another local patch applied
6. issue persists
7. only later are server truth and persistence model inspected
8. major backend/storage design flaw is finally found

This is exactly the sequence that must be avoided.

---

## Durable debugging rule

For Presence, Presence-like apps, or any split system with client + service/backend:

### Never debug from one side only
Always inspect both:
- **service/backend truth**
  - sessions
  - bindings
  - devices
  - audit events
  - persistence/storage model
  - endpoint behavior
- **client/app truth**
  - local persisted state
  - merge/update/recovery paths
  - actual rendered source data
  - UX state derivation

### Required order
1. Restate the product requirement in plain user language
2. Confirm the symptom with evidence
3. Check server/service authoritative truth
4. Check app/local truth
5. Compare server truth vs app truth
6. Only then choose fix location:
   - backend persistence
   - backend API
   - sync/hydration path
   - client state merge
   - pure UI/render issue
7. Apply one coherent fix set
8. Verify against the original product requirement

---

## Escalation rule

If 1 patch does not close the issue clearly, or if confidence is low before patch 1:
- stop patching
- switch to investigation mode immediately
- do not continue speculative local edits

In practice, for non-trivial bugs:
- investigation should happen **before** patching, not after several failed patches

---

## Anti-regression rule

Do not describe a strategy as "minimal fix" unless both are true:
1. the root cause is already evidenced
2. the proposed fix fully covers that cause

If either is false, calling it "minimal" is misleading and dangerous.

Preferred language:
- "root-cause-first fix"
- "smallest complete fix"
- "authoritative fix path"
- "temporary fallback until authoritative path is live"

---

## Presence-specific lesson from this incident

The Service-tab issue was not just a UI/list bug.
It involved both sides:

### Backend/service side
- live linkage store used tmp storage
- durable binding/device truth was not reliably preserved
- authoritative device-bindings endpoint was missing

### App side
- app relied on incomplete public reconstruction paths
- local state alone could under-represent the real or intended full binding list
- UI-only patching could not solve the whole problem

So the correct debugging unit is:
- **app + service + persistence + API surface together**

---

## Human-impact reminder

Repeated speculative fixes cause:
- token waste
- time waste
- regression risk
- code messiness
- reduced confidence
- user fatigue

This is not a minor style issue. It is a trust issue.

---

## Default operating rule going forward

When debugging important issues:
- investigate first
- use official/runtime evidence first
- compare both backend truth and app truth
- then perform one coherent, justified fix
- prefer correctness over repeated local patch churn

If uncertain, pause and widen the investigation rather than shipping another guess.
