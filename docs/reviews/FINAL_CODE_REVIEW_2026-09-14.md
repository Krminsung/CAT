# 최종 코드 리뷰 — 2026-09-14

## 결론과 범위

정적 리뷰에서 수정이 필요한 항목 4건을 확인했다. P1 1건, P2 3건이며, 현재 상태를 런타임까지 검증된 배포 완료 상태로 판단하지 않는다. 특히 R01은 기본 도구를 포함하는 OpenAI 모델 요청 자체를 막는 문제다.

- 대상: `/home/smile/cat`, `main`, HEAD `4abb0ea84c7f5306706e521cefc1729688c70b59`.
- 기준: `AGENTS.md`, `CAT_CODEX_IMPLEMENTATION.md`의 제품 기능·권한·저장·자원 정리 계약.
- 방식: 주요 진입점과 모듈 간 호출을 추적한 정적 코드 리뷰. 모든 소스의 모든 행이나 모든 공격 시나리오를 검증했다는 의미는 아니다.
- 코드 수정, 커밋, push, PR 변경은 하지 않았다. 이번 변경은 이 리뷰 문서뿐이다.
- typecheck, build, test, 앱·설치본 실행, 실제 모델·MCP 호출, 프로세스 종료 실험은 하지 않았다. 아래 발생 조건은 코드와 규격에서 도출했으며, 실행 재현 결과가 아니다.
- 외부 규격은 공개 공식 문서만 확인했으며 저장소 코드나 자격 증명을 전송하지 않았다.

P1은 우선 해결해야 하는 주요 기능 차단, P2는 특정 조건에서 발생하는 보안·정합성·운영 결함을 뜻한다. 아래 수정 방향과 검증 항목은 제안이며 실행하지 않았다.

| ID | 우선순위 | 문제 | 상태 |
| --- | --- | --- | --- |
| R01 | P1 | 선택 인자가 있는 도구 스키마에 strict 모드를 강제함 | 미수정 |
| R02 | P2 | 조각으로 나뉜 비밀값이 스트리밍 출력·이벤트 기록에 남음 | 미수정 |
| R03 | P2 | 직접 자식의 close를 전체 프로세스 그룹 종료로 간주함 | 미수정 |
| R04 | P2 | run 종료 전에는 assistant/tool 실행 기록이 영구 저장되지 않음 | 미수정 |

## R01 — strict 도구 스키마의 필수 인자 계약 불일치

주요 위치: [src/tools/command-tool.ts:309](/home/smile/cat/src/tools/command-tool.ts:309), [src/tools/runtime.ts:313](/home/smile/cat/src/tools/runtime.ts:313).

`run_command`의 `properties`에는 `command`, `timeout_seconds`, `background`, `deadline_seconds`가 있지만 `required`에는 `command`, `background`만 있다. 그런데 내장 도구 등록은 모두 `strictProviderSchema: true`를 설정한다. `providerSpec()`은 스키마를 복사할 뿐 strict 호환 형태로 변환하지 않는다.

이 값은 [Responses adapter:224](/home/smile/cat/src/providers/responses-adapter.ts:224)와 [Chat adapter:222](/home/smile/cat/src/providers/chat-adapter.ts:222)를 통해 그대로 요청에 포함된다. [provider catalog:76](/home/smile/cat/src/providers/catalog.ts:76)의 OpenAI 설정은 strict 지원을 켜고 있다.

발생 조건과 영향:

- OpenAI provider에서 `run_command`가 노출되는 기본 도구 구성을 사용한다. `ask` 모드에서 셸 실행 승인을 아직 하지 않았어도 도구 정의는 모델에 전달된다.
- strict 모드는 모든 `properties` 항목을 `required`로 지정해야 하며 선택 값은 nullable 등으로 표현해야 한다. 규격에 맞지 않는 `strict: true` 요청은 거절된다. [OpenAI 공식 function calling 규격](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
- 따라서 모델이 실제로 `run_command`를 선택하기 전, 단순 대화의 첫 요청도 거절될 수 있다. 호스트의 입력 검증 성공이나 TypeScript 컴파일 성공으로 탐지되지 않는다.
- `internal`도 strict 플래그를 보내지만 그 서버의 실제 검사 방식은 이번에 확인하지 않았다. 모든 호환 provider가 동일하게 실패한다고 단정하지 않는다.

수정 방향: 호스트 입력 스키마와 provider 전송 스키마를 구분하고, strict 호환성이 확인된 정의만 strict로 보낸다. nullable 변환을 택하면 호스트 validator 및 foreground/background handler의 인자 처리도 함께 맞춰야 한다. strict를 생략하는 것만으로 Responses의 동작을 통제할 수 있다고 가정하지 않는다.

후속 검증 제안: 최종 직렬화된 모든 내장 도구 정의의 strict 제약을 검사하고, foreground/background 각각의 입력과 기본 OpenAI 요청을 승인된 환경에서 확인한다.

## R02 — 이벤트 경계를 가로지르는 비밀값을 가리지 못함

주요 위치: [src/cli/output.ts:186](/home/smile/cat/src/cli/output.ts:186), [src/storage/jsonl.ts:465](/home/smile/cat/src/storage/jsonl.ts:465).

[TextDeltaGate:413](/home/smile/cat/src/agent/runner.ts:413)는 일반 텍스트의 provider delta를 개별 `text_delta` 이벤트로 내보낸다. `CliOutput.agentEvent()`는 각 이벤트를 즉시 JSON 한 줄로 직렬화하며, JSONL 저장도 이벤트 하나의 문자열 값에 redaction을 적용한다. [Redactor:19](/home/smile/cat/src/security/redaction.ts:19)는 이전 조각을 기억하지 않으며, 알려진 비밀값의 전체 문자열을 현재 입력에서만 찾는다.

발생 조건과 영향:

- 모델 응답에 가려야 할 값이 들어 있고 SSE에서 둘 이상의 delta로 나뉜다.
- 예를 들어 알려진 가상 비밀값 `exampleCredential9876`이 `exampleCred`와 `ential9876`으로 전달되면 각 조각은 전체 비밀값과 일치하지 않는다. 일반 토큰 정규식에도 걸리지 않는 이 예에서는 두 조각 모두 남고, 이벤트 순서대로 합치면 원래 값이 복원된다. 실제 자격 증명을 사용한 예가 아니다.
- `--output-format stream-json`의 stdout과, run 완료 뒤 저장하는 `agent_event` 기록이 영향을 받는다. 마지막 완성 응답을 별도로 가렸더라도 이미 출력·저장한 조각은 제거되지 않는다.
- TUI는 누적 텍스트를 다시 가리는 별도 경로를 사용하므로, 이 항목은 우선 JSON 스트림과 이벤트 저장의 결함으로 한정한다.

수정 방향: 공개 출력·이벤트 저장 앞에 메시지별 경계를 인식하는 bounded streaming redaction을 둔다. 알려진 비밀값의 부분 접두사는 확정될 때까지 보류하고, 패턴형 secret도 조각 경계를 고려한다. 안전한 스트리밍 처리가 어려운 경로는 완성된 안전 텍스트만 공개한다. 취소·오류·run 종료 시 남은 조각을 그대로 flush하지 않도록 해야 한다.

후속 검증 제안: 가상 비밀값을 모든 분할 위치로 나눈 delta, 토큰 패턴과 private-key block, 중간 취소를 입력으로 삼아 stdout과 저장 JSONL을 재조립해도 값이 복원되지 않는지 확인한다.

## R03 — 직접 자식 종료 후 살아 있는 후손의 관리 정보와 종료 타이머를 버림

주요 위치: [src/process/child-process.ts:182](/home/smile/cat/src/process/child-process.ts:182), [src/process/background-tasks.ts:913](/home/smile/cat/src/process/background-tasks.ts:913).

foreground 실행은 프로세스 그룹에 SIGTERM을 보내고 250ms 후 SIGKILL을 예약하지만, 직접 자식의 `close`가 발생하면 `finish()`가 그 타이머를 취소한다. background도 직접 자식의 `close`에서 `terminationConfirmed = true`로 확정하고 PID·child 참조와 타이머를 지운다.

발생 조건과 영향:

- 셸이 후손을 시작하고, 그 후손은 stdout/stderr를 파일 또는 `/dev/null`로 돌린다.
- 취소·timeout에서 직접 자식은 SIGTERM으로 종료하지만 후손은 SIGTERM을 무시하고 계속 동작한다. 같은 프로세스 그룹에 남아 있는 경우만으로도 문제가 성립하며, 별도 세션으로 탈출할 필요가 없다.
- Node의 `close`는 직접 자식의 종료와 해당 stdio 폐쇄를 의미한다. 후손 전체의 종료를 증명하지 않는다. [Node.js 공식 ChildProcess 문서](https://nodejs.org/api/child_process.html#event-close)
- 예약된 SIGKILL이 취소되어 후손이 남을 수 있다. background에서는 종료가 확인됐다고 표시하고 관리 정보를 지워 이후 세션 정리에서도 놓친다. CPU·네트워크 사용이나 파일 변경이 사용자가 취소한 뒤 계속될 수 있다.
- 직접 자식이 정상 종료하고 출력이 분리된 후손만 남긴 경우에도 전체 작업이 완료된 것으로 처리하는 같은 문제가 있다.
- [MCP transport:486](/home/smile/cat/src/mcp/stdio-transport.ts:486)에도 `close`에서 TERM/KILL 타이머를 취소하는 동일한 패턴이 있으므로 함께 다뤄야 한다.

수정 방향: 직접 자식의 종료와 소유 프로세스 그룹의 정리를 별개 상태로 관리한다. 소유권이 유지되는 동안 그룹 정리를 완료하거나, 확인 불가 상태를 명시하고 관리 정보를 보존한다. 단순히 지연된 PID에 무조건 신호를 보내는 수정은 PID/PGID 재사용 위험이 있으므로 피한다. 이 수정이 임의 셸의 완전한 sandbox를 제공한다고 주장해서도 안 된다.

후속 검증 제안: 임시 환경에서 출력이 분리되고 SIGTERM을 무시하는 후손을 둔 foreground/background/MCP 작업을 각각 취소한다. 직접 자식 상태뿐 아니라 소유 그룹의 잔존 여부와 종료 확인 표시를 점검한다.

## R04 — run 도중 프로세스가 종료되면 이미 실행한 도구의 대화·감사 기록이 유실됨

주요 위치: [src/app/application.ts:1494](/home/smile/cat/src/app/application.ts:1494), [src/app/application.ts:1069](/home/smile/cat/src/app/application.ts:1069).

`#executePrompt()`는 사용자 메시지를 저장한 다음 `await this.#runner.run(...)`을 기다린다. 그동안 `onEvent`는 화면과 stdout에만 전달된다. assistant/tool 메시지와 agent event의 영구 저장은 run 전체가 반환된 뒤에 시작한다. [실행 ledger:83](/home/smile/cat/src/agent/execution-records.ts:83) 역시 메모리 Map이다.

발생 조건과 영향:

- 지속 저장을 켠 세션에서 셸 또는 MCP 도구가 부작용을 발생시킨 뒤, 다음 모델 응답을 기다리는 동안 SIGKILL·전원 장애 등으로 앱이 종료된다.
- 부작용은 남지만 해당 run의 `tool_start`, 결과, assistant/tool 메시지는 transcript에 없다. 마지막 사용자 요청만 저장되어 있을 수 있으며, 완료와 실행 여부 불명을 구분할 근거도 사라진다.
- 재개 후 사용자·모델이 이미 수행한 작업을 파악하기 어렵고, 후속 요청에서 중복 작업을 제안·실행할 위험이 생긴다. 현재 코드가 무조건 자동 재실행한다는 뜻은 아니다.
- 파일 checkpoint 및 background task의 별도 저장은 일부 상태를 보완하지만 임의 셸·MCP 부작용과 전체 대화 관계를 대체하지 않는다.
- run 종료 후 일괄 저장 중 실패해도 앞부분만 남을 수 있다. JSONL writer 자체가 안전하게 append하더라도 상위 호출이 run 끝까지 쓰기를 미루는 문제는 해결되지 않는다.

수정 방향: 실제 도구 실행 전에 시작 상태를 내구성 있게 기록하고, 실행 결과와 완성된 메시지를 진행에 맞춰 순차 저장한다. 저장 실패 시 후속 mutation을 계속할지 명시적으로 결정하며, 재개 때 결과가 없는 시작 기록은 `unknown`으로 복원한다. 이벤트·메시지 중복 기록 및 불완전한 tool-call/result 관계도 함께 처리해야 한다.

후속 검증 제안: 도구 시작 직전·부작용 직후·다음 모델 응답 대기·결과 기록 중에 각각 중단시킨 세션을 재개한다. 이미 수행한 작업을 성공 또는 미실행으로 추측하지 않고 기록과 불명 상태로 보여주는지 확인한다.

## 그 밖에 확인한 경계와 남은 한계

추가 결함을 확정하지 않은 영역도 안전성을 보증하는 의미는 아니다.

- 중앙 도구 실행의 schema → hard policy/trust → hook → approval → 재확인 경로와 provider 노출 경로를 추적했다.
- 파일 경로·민감 경로 보호, 기존 파일 identity/hash 확인, 임시 파일 교체, checkpoint 복구 실패 보존 코드를 확인했다. OS 경쟁 조건을 제거했다고 판정하지 않았다.
- 공개 웹 transport의 DNS 주소 고정, 실제 연결 주소 확인, TLS hostname 검사, proxy 차단과 모델 인증 transport 분리를 확인했다. 실제 SSRF 공격·DNS rebinding 실험은 하지 않았다.
- CLI/TUI 진입·출력·입력·복원 관련 주요 코드, 세션 저장·컨텍스트 연결, MCP 요청·종료 경계, worktree 제거의 dirty/ignored 검사 및 branch 보존 코드를 읽었다. 한국어 입력, paste, resize, 실제 MCP 서버 상호운용성은 미검증이다.
- wrapper, packaging 입력 검사·Node checksum, installer의 사용자 경로 제한·staging·backup/rollback 경로를 확인했다. x64/arm64 설치·업그레이드·실패 복원은 실행하지 않았다.
- 의존성 취약점 전수 감사, 성능 측정, 실제 모델별 상호운용성 검증, 원본 대비 모든 UI 동작의 회귀 검증은 이번 정적 리뷰에 포함하지 않았다.

다음 작업은 R01–R04의 수정 범위와 검증 허용 범위를 별도로 정한 뒤 진행한다. 이 문서는 수정 완료나 추가 실행 승인을 의미하지 않는다.
