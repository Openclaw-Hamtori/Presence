# Presence_GPT Regression Checklist

Historical/archive note:
- This checklist is preserved as release-validation evidence from the final pre-audit pass, not as the canonical current product explainer.
- When wording here reflects older runtime validation language, prefer the current public model in `docs/`: link once, stay linked, prove on demand.

이 체크리스트는 기능 추가/수정 후, 기존에 되던 핵심 흐름이 깨지지 않았는지 확인하기 위한 기준이다.

## Rule
- 기능 하나를 추가한 뒤에는 아래 항목을 다시 확인한다.
- 체크리스트를 통과하기 전에는 해당 단계 완료로 간주하지 않는다.
- 가능하면 자동 체크(type-check/build/test) + 수동 체크(UI/device flow)를 같이 본다.

---

## 0. Baseline Build / Test
- [x] `presence-sdk` build 통과
- [x] `presence-sdk` test 통과
- [x] `presence-verifier` build 통과
- [x] `presence-verifier` test 통과
- [x] `presence-mobile` type-check 통과
- [x] `presence-test-app` type-check 통과

---

## 1. App Launch
- [x] iPhone 실기기에 앱 설치 가능
- [x] 앱 실행 직후 크래시 없음
- [x] 메인 화면 렌더링 정상

## 2. Health Permission Flow
- [x] `인증` 또는 권한 요청 흐름에서 Health 권한 요청 정상 표시
- [x] 권한 허용 후 앱 상태 업데이트 정상

## 3. PASS Evaluation
- [ ] 최근 72시간 rolling window 기준 PASS 계산 동작
- [ ] 로컬 날짜 기준 하루 판정 동작
- [ ] 현재 기준 반영 확인:
  - [ ] 유효 BPM 샘플 6개 이상
  - [ ] 서로 다른 10분 버킷 3개 이상
  - [ ] BPM 값 완전 고정 아님
  - [ ] steps 100 이상
- [x] 앱에서 PASS / NOT READY 표시가 기대대로 보임

## 4. Proof Generation
- [ ] direct prove 동작
- [ ] payload 생성 정상
- [ ] link context 없는 로컬 proof 생성 가능

## 5. Link Flow
- [ ] demo link 생성 동작
- [x] `링크 열기` 동작
- [x] 세션 열림 상태가 UI에서 눈에 띄게 보임
- [x] 승인 가능 상태 확인 가능
- [ ] link_context 포함 proof 생성 가능
- [x] trust failure가 connect modal 안에서 명확히 보임
- [x] trust failure 메시지가 입력 수정 / modal 닫기 / 다른 세션 로드 때 clear됨
- [x] proper HTTPS + `/.well-known/presence.json` trust happy-path가 real iPhone에서 통과함

## 6. QR Flow
- [x] QR 버튼 동작
- [x] 카메라 권한 요청 정상
- [x] 카메라 화면 표시 정상
- [x] QR payload 스캔 후 Presence 링크로 인식 가능
- [x] 스캔 후 세션 열림 상태로 전환

## 7. Linked Auth / Reference Round-trip
- [x] reference server에서 session 생성 가능
- [x] complete 호출 가능
- [x] binding 저장 확인 가능
- [x] linked account verify 가능
- [x] FAIL 시 explicit not_ready 전송 없이 마지막 PASS 만료/유예 해석으로 readiness가 내려가는 구조 유지
- [x] mismatch 시 recovery 흐름 확인 가능

## 8. Attestation
- [ ] iOS App Attest verifier 경로 기본 검증 유지
- [ ] Android Play Integrity verifier 경로 기본 검증 유지
- [ ] attestation 관련 변경이 기존 prove/link 흐름을 깨지 않음

## 9. UX Regression
- [ ] 메인 화면이 다시 개발용 로그 화면처럼 돌아가지 않았음
- [ ] 사용자용 주요 액션은 단순하게 유지됨
- [ ] dev/debug 도구는 분리되어 있음

## 10. Runtime Notes / Known Behavior
- [x] 이미 사용했거나 만료된 deeplink는 `nonce expired or not issued by service`로 실패할 수 있음
- [x] fresh deeplink에서는 같은 기기/앱 상태에서 즉시 정상 링크 성공 재현됨
- [x] 이 동작을 사용자/통합자 문서의 known behavior 또는 troubleshooting에 정리

---

## Completion Rule
각 큰 단계(1~5)를 끝냈다고 보고하기 전에:
1. 바뀐 범위와 직접 관련된 항목은 반드시 재확인
2. 최소한 App Launch / PASS / Proof / Link 중 영향 받는 핵심 항목은 다시 확인
3. 회귀 의심 항목이 있으면 다음 단계로 넘어가지 않음
