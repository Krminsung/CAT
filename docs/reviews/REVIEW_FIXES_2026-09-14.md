# 최종 리뷰 후속 수정

- 기준 HEAD: `4abb0ea84c7f5306706e521cefc1729688c70b59`.
- 사용자 승인: 최종 리뷰 R01–R04의 코드 수정 및 보완. 추가 실행 검증 승인은 포함하지 않는다.
- P14 후속 수정이며 기존 P01–P14 검사 횟수와 결과는 보존한다. 새 검사 예산을 만들지 않는다.
- 구현은 detached HEAD에서 순차 커밋하고 `refs/cat-progress/P14-review-fixes`에 보존한다. 검증 승인 전에는 push/PR/merge하지 않는다.

## 진행

- R01: 내장 도구 스키마의 보수적 strict 호환성 판정을 추가했다. 선택 인자나 호환성을 확정하지 않은 제약이 있으면 strict를 false로 전송한다. 호스트 검증과 기존 입력 형식은 유지했다.
- R02: `text_complete` 이벤트를 추가하고 JSON stdout 및 이벤트 저장에서 원시 `text_delta`를 제외했다. 완성 텍스트 전체를 기존 redactor로 처리한다. 취소·오류 중 미완성 조각은 공개/저장 경로로 flush하지 않는다. TUI의 실시간 렌더링은 유지한다.
- R03: foreground/background/MCP에 소유 그룹 정리 경계를 연결했다. 직접 자식 close 이후에도 TERM→KILL 정리를 기다리며, Linux에서는 관측한 PID·PGID·session·시작 시각을 다시 확인하고 신호를 보낸다. 종료 확인에 실패하면 성공 대신 unknown/오류를 반환하고 background 기록과 관측 PGID를 보존한다. MCP의 미확인 소유 process를 제거하거나 재시작하지 않는다.
- R03 한계: 직접 자식이 관측되지 않은 후손을 남기고 먼저 종료했거나 `/proc` 관측이 제한되면 그룹 소유권을 추측해 강제 종료하지 않는다. 정리 불명으로 보고하고 수동 조치를 요구한다. 그룹을 벗어난 임의 daemon까지 격리하는 sandbox는 아니다. [Linux proc stat 규격](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)을 참고했다.
- R04: runner의 영구 저장 port와 순차 저장 경계를 추가했다. 완성 assistant 메시지, 도구 시작 기록을 handler 실행 전에 저장하고 도구 결과는 다음 실행 전에 저장한다. run 종료 후 일괄 재저장은 제거했다. 직접 도구 실행도 같은 순서를 적용한다. JSONL append의 기존 fsync를 사용한다.
- R04: 저장 실패는 해당 run과 앱의 후속 실행을 차단한다. 실패한 append를 자동 재시도하지 않는다. 재개 시 미완료 native call/result 쌍은 기존 완료 결과를 보존하면서 누락 결과를 unknown으로 투영한다. fallback 및 직접 실행의 시작/결과 이벤트도 추적해 모델과 사용자에게 미확인 실행을 알린다. TUI에 이전 호출이 계속 실행 중인 것처럼 표시하지 않는다.
- 복구는 원본 transcript를 고쳐 쓰거나 도구를 재실행하지 않는다. 실제 외부 부작용까지 원자적으로 보장하는 transaction은 아니며, 기록 사이의 중단은 보수적인 unknown으로 처리한다.

## 검증과 배포

소스 읽기와 diff 검토를 수행했다. 추가 typecheck/build/test/앱 실행/패키징은 미실행이다. 기존 `dist/`와 `artifacts/`는 이번 수정이 반영된 배포물이 아니다.

수정 커밋: R01 `ac7cdf9`, R02 `1304ff6`, R03 `3b22d71`, R04 `563e8ae`. 별도 안전 ref에 로컬 보존했으며 main 변경·원격 push·PR·병합은 하지 않았다.

현재 상태는 `AWAITING_VERIFICATION_APPROVAL`이다. 다음 최소 검증으로 수정본의 `npm run check` 1회 실행 승인을 요청한다. 기존 P14 빌드 통과를 새 코드의 검증 결과로 재사용하지 않는다. 타입 검사 승인만으로 build·installer 재포장·런타임 테스트도 승인된 것으로 간주하지 않는다.

## 추가 검사 1회 승인 및 예약

- 사용자가 수정본의 `npm run check` 1회 실행을 명시적으로 승인했다.
- 승인 예약: 2026-09-14 01:24:44 UTC. 상태를 `VERIFYING`으로 변경하고 실행 기회를 먼저 예약했다.
- 코드 HEAD: `563e8aefb7498b46cad003a83a695ff0ffef6201`. 실제 검사 대상은 이 예약 문서 커밋의 HEAD로 확정한다.
- 원격 main은 기준 `4abb0ea84c7f5306706e521cefc1729688c70b59`와 동일함을 읽기 전용 조회로 확인했다.
- 명령은 `npm run check`이며 `tsc -p tsconfig.json --noEmit`만 수행한다. timeout 120초, 재실행 없음. build·패키징·앱·테스트 실행은 포함하지 않는다.
