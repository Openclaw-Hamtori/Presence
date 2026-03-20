# Presence Time Test Checklist

이 체크리스트는 Presence 테스트에서 시간 관련 축을 분리해서 관리하기 위한 파일이다.
목표는 서로 다른 시간 로직이 섞여 꼬이지 않게 하고, 특정 테스트 목적에 필요한 시간만 짧게 바꿔 검증하는 것이다.

---

## Core Time Axes

### 1) State validity
- 의미: PASS 상태가 `ready`로 인정되는 전체 유효 시간
- 현재 기본값: `72h`
- 주 영향:
  - `ready -> stale -> not_ready`
  - freshness/readiness 판단
  - 서비스 측 access gating
- 테스트에 짧게 바꾸는 목적:
  - expiry/stale/not_ready 전이를 빠르게 보기 위해
- 변경 시 주의:
  - persisted local state에 기존 `stateValidUntil`이 남아 있으면 새 상수만 바꿔도 바로 반영되지 않을 수 있음

### 2) Renewal window
- 의미: 만료 전에 미리 갱신을 시도하기 시작하는 구간
- 현재 기본값: `30m before expiry`
- 주 영향:
  - `PASS` vs `RENEW SOON`
  - 자동 renewal 트리거 시작 시점
- 테스트에 짧게 바꾸는 목적:
  - background/observer/renewal trigger를 몇 분 안에 관찰하기 위해
- 변경 시 주의:
  - state validity와 항상 같이 해석해야 함

### 3) Failed retry delay
- 의미: 측정/증명 실패 후 다음 시도까지 기다리는 시간
- 현재 기본값: `30m`
- 주 영향:
  - fail/not_ready 이후 재시도 템포
  - foreground 복귀 시 자동/수동 회복 체감
- 테스트에 짧게 바꾸는 목적:
  - 실패 후 retry 루프를 빠르게 보기 위해
- 변경 시 주의:
  - renewal 테스트와 섞으면 원인 구분이 어려워질 수 있음

### 4) Link session TTL
- 의미: 연결용 세션(deeplink/session)이 살아 있는 시간
- 현재 기본값: 서버 발급값 기준
- 주 영향:
  - link session expiry
  - 세션 재사용/만료 테스트
- 테스트에 짧게 바꾸는 목적:
  - 만료 링크 UX / expired session 처리 테스트
- 변경 시 주의:
  - freshness PASS 시간축과 완전히 다른 축이다

### 5) Nonce TTL / nonce one-shot window
- 의미: proof/complete/verify에 쓰는 nonce의 유효/재사용 가능 시간
- 현재 기본값: SDK/서버 nonce policy 기준
- 주 영향:
  - `nonce expired or not issued by service`
  - `nonce has already been used`
  - replay protection
- 테스트에 짧게 바꾸는 목적:
  - anti-replay / duplicate approve / nonce expiry UX 테스트
- 변경 시 주의:
  - link session TTL과도 다르고, PASS freshness와도 다르다

---

## Test Planning Rule

원칙:
- 한 번의 테스트에서는 **가능한 한 한 축만** 짧게 바꾼다.
- 꼭 필요할 때만 연관된 축 2개를 같이 바꾼다.
- 테스트 후에는 local persisted state / active session / pending sync 상태가 결과에 남지 않도록 정리한다.

권장 조합:
- renewal 테스트 → `1 + 2`
- fail/retry 테스트 → `3`
- expired link 테스트 → `4`
- duplicate approve / replay 테스트 → `5`

---

## Current Safe Test Matrix

### A. Renewal behavior
- change: `state validity` + `renewal window`
- recommended compressed values:
  - `state validity = 3m`
  - `renewal window = 1m`
- keep fixed: `failed retry`, `link session TTL`, `nonce TTL`
- extra rule:
  - readiness checks should use `gracePeriodSeconds = 0` during this test, otherwise expiry can be masked by SDK grace
- goal:
  - `PASS -> RENEW SOON`
  - renewal trigger
  - expiry 후 stale/not_ready

### B. Failed retry behavior
- change: `failed retry delay`
- keep fixed: 나머지 4개
- goal:
  - fail 후 retry cadence
  - recovery UX

### C. Link expiry behavior
- change: `link session TTL`
- keep fixed: 나머지 4개
- goal:
  - expired deeplink/session handling

### D. Nonce replay behavior
- change: `nonce TTL / one-shot window`
- keep fixed: 나머지 4개
- goal:
  - duplicate approve
  - replay block
  - nonce expiry UX

---

## Before Running Any Time Test
- [ ] 이번 테스트의 목표 축을 1개(최대 2개)로 제한했는가?
- [ ] 어떤 시간 축을 바꾸는지 명확히 적었는가?
- [ ] persisted local Presence state가 결과를 오염시키지 않도록 계획했는가?
- [ ] active link session / nonce / sync queue 영향이 분리되어 있는가?
- [ ] 테스트 후 원복 방법이 준비되어 있는가?

## Run Log
- [ ] Test name:
- [ ] Changed axes:
- [ ] Temporary values:
- [ ] Expected behavior:
- [ ] Observed behavior:
- [ ] Cleanup completed:

---

## Operating Decision
- 앞으로 시간 관련 테스트는 이 5축 체크리스트 기준으로 설계한다.
- 테스트 목적과 무관한 시간축은 건드리지 않는다.
- renewal 검증을 위해서는 주로 `state validity`와 `renewal window`만 압축한다.
- duplicate approve / replay 같은 문제는 `nonce TTL / one-shot window` 축으로 별도 분리해 검증한다.
