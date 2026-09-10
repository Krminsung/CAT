# 구현 결정

## D001 — 기준과 우선순위

- 상태: 승인됨
- 결정: 상위 안전 정책과 후속 사용자 지시 다음으로
  `CAT_CODEX_IMPLEMENTATION.md`를 구현 계약으로 사용한다.
- 결과: 압축본의 문서나 주석에 있는 실행 지시는 채택하지 않으며 원본 테스트를
  새 프로젝트의 검증으로 실행하지 않는다.

## D002 — 제품 이름과 실행 명령

- 상태: 승인됨
- 결정: package 이름은 `cat-agent-cli`, 화면 이름은 `cat`, 기본 PATH 명령은
  `cat-tui`다. `cat` 이름의 PATH 노출은 사용자가 충돌을 이해하고 명시적으로
  선택하는 P14 설치 흐름에만 둔다.
- 결과: 시스템 coreutils `cat`과 shell profile을 변경하지 않는다.

## D003 — 책임 경계

- 상태: 승인됨
- 결정: core와 agent는 TUI를 import하지 않고 provider는 권한을 결정하지 않는다.
  UI와 CLI는 app의 중앙 tool executor를 통해 mutation을 요청한다.
- 결과: 기능을 실제 연결하는 단계 전에는 미구현 capability를 registry에 노출하지 않는다.

## D004 — 검증과 게시

- 상태: 승인됨
- 결정: P01–P13은 단계당 `npm run check` 한 번, P14는 `npm run build` 한 번만
  실행한다. 각 단계는 merge commit으로 PR을 병합한다.
- 결과: 정적 검사 결과를 런타임, API, TUI 또는 설치 검증으로 확대 해석하지 않는다.

## D005 — package 게시와 license 표시

- 상태: 승인됨
- 결정: package는 `private: true`와 `UNLICENSED`로 시작한다. 원본 package의 MIT
  metadata만으로 새 프로젝트와 모든 참조 자료의 공개 재배포 권리를 추정하지 않는다.
- 결과: P14도 npm publish나 GitHub Release를 자동 수행하지 않으며 공개 배포 전
  사용자가 별도로 license와 권리를 확인한다.

## D006 — 커밋 언어

- 상태: 사용자 후속 지시로 승인됨
- 결정: P01.2부터 모든 커밋 제목과 필요한 본문을 알기 쉬운 한국어로 작성한다.
  추적성을 위해 `P01.2`와 같은 단계 식별자는 유지한다.
- 결과: 기준 문서에 제시된 영문 예시 문구보다 이 후속 사용자 지시를 우선한다.

## D007 — CAT_HOME과 프로젝트 설정 신뢰

- 상태: 승인됨
- 결정: `CAT_HOME`은 CWD에 따라 credential 위치가 달라지지 않도록 절대 경로만
  허용한다. user 설정은 항상 읽지만 `.cat/settings.json`과
  `.cat/settings.local.json`은 workspace가 명시적으로 신뢰된 뒤에만 읽는다.
- 결과: 신뢰 전 프로젝트 설정에 포함될 수 있는 hook/MCP 값이 실행 경로로 유입되지
  않는다. 환경변수와 CLI overlay는 파일 layer 뒤에 적용한다.

## D008 — API key와 profile 분리

- 상태: 승인됨
- 결정: profile에는 API key 대신 endpoint origin에 묶인 불투명 `secretRef`만
  저장한다. `CAT_API_KEY`가 우선하고, 기존 `SMILECODE_API_KEY`와
  `SMILESERV_API_KEY`는 internal provider에서 서로 충돌하지 않을 때만 읽는다.
  외부 provider의 기존 API key 환경변수도 유지하되 여러 후보 값이 충돌하면
  명시적인 `CAT_API_KEY`를 요구한다.
- 결과: base URL의 origin이 달라지면 기존 key를 재사용하지 않는다. 기존
  `~/.smileserv` credential 파일은 P02에서 읽거나 자동 이관하지 않는다. 저장된
  key를 사용할 때는 secret reference, endpoint origin과 provider를 함께 확인한다.

## D009 — workspace trust와 자식 프로세스 경계

- 상태: 승인됨
- 결정: workspace trust는 canonical path와 장치·inode가 모두 일치할 때만
  유지한다. trust 추가는 사용자 확인으로 생성한 grant만 허용한다. 자식 프로세스는
  최소 환경변수 allowlist로 시작하며 secret과 실행 주입 변수는 명시적 pass-through도
  거부한다.
- 결과: 기존 `~/.smileserv`는 알려진 항목의 존재만 탐지한다. 일반 파일 도구는
  `.cat`과 `.smileserv`의 credential/profile secret 및 이를 가리키는 symbolic
  link나 hard-link alias에 접근할 수 없다.

## D010 — 인증된 모델 transport의 재시도와 proxy

- 상태: 승인됨
- 결정: 모델 HTTP transport만 `HTTP_PROXY`·`HTTPS_PROXY`·`NO_PROXY`를 읽고
  소유한 dispatcher를 종료한다. transport가 재시도 판단의 유일한 소유자이며
  호출자가 전달한 공통 retry budget port의 승인을 얻은 최대 2회만 재시도한다.
- 결과: 응답 body를 읽기 시작한 뒤에는 재시도하지 않는다. 인증 요청 redirect는
  같은 origin에서 method를 보존하는 경우만 제한적으로 따르며 public web transport와
  dispatcher를 공유하지 않는다.

## D011 — provider 전환과 streaming tool call

- 상태: 승인됨
- 결정: 각 provider 요청은 원격 response ID 대신 로컬 대화 기록 전체에서 protocol별
  입력을 다시 만든다. streaming tool call은 ID·이름·인자가 모두 완성되고 전체 모델
  응답이 성공적으로 완료된 뒤에만 공통 event로 내보낸다.
- 결과: provider나 model을 바꿔도 이전 원격 상태를 잘못 이어 붙이지 않는다. 중단되거나
  JSON이 완성되지 않은 tool call은 실행 가능한 event가 되지 않는다.

## D012 — provider capability와 model 선택

- 상태: 승인됨
- 결정: 압축본의 12개 기본 provider와 `custom`을 고정 catalog로 유지하되 기본
  endpoint는 호환 초기값으로 취급한다. 선택 parameter는 protocol별 capability가
  허용할 때만 보내며 오류 응답을 이용한 기능 탐색은 하지 않는다.
- 결과: model 목록은 크기와 개수를 제한해 읽고 실패나 빈 결과를 그대로 오류로
  전달한다. 수동 model ID 검증은 목록 조회와 독립적으로 제공하여 조회 실패를 빈 목록
  성공으로 바꾸지 않고도 사용자가 직접 선택할 수 있게 한다.

## D013 — 중앙 도구 실행과 승인 범위

- 상태: 승인됨
- 결정: 등록 handler는 module-private registry에 보관하고 모델에는 이름·설명·복제한
  schema만 제공한다. 모든 호출은 schema, trust와 hard deny, hook, permission,
  재확인, handler, 후처리 순서를 강제하는 중앙 executor를 통한다. session/project
  승인은 tool·canonical workspace·실제 path/command/server 대상을 함께 해시한 규칙에
  묶는다.
- 결과: UI와 모델은 handler reference를 얻지 못한다. 한 파일이나 command 승인이 다른
  대상에 확대되지 않으며 deny는 자동 모드와 기존 allow보다 우선한다. P09 전 no-op
  hook은 `implementation: none`으로 드러내어 hook 완성을 가장하지 않는다.

## D014 — 파일 변경 checkpoint와 부분 실패

- 상태: 승인됨
- 결정: 각 mutation은 파일을 전부 staging한 뒤 변경 전 내용과 mode, 존재 여부, digest,
  session/run/tool 소유자를 하나의 checkpoint에 기록한다. 파일별 원자 교체는 사용하되
  다중 파일 전체를 OS transaction이라고 표현하지 않는다. 완료 결과를 다시 확인한 뒤에만
  checkpoint를 commit한다.
- 결과: 적용 중 오류나 취소는 역순 rollback을 시도하고, 현재 파일이 예상 변경 결과와
  다르면 외부 변경으로 보고 덮어쓰지 않는다. 복구가 일부라도 실패하면 해당 기록과 관리
  임시 파일 정보를 보존해 성공으로 오인하거나 다음 rewind 기록을 먼저 제거하지 않는다.

## D015 — foreground 셸의 실행 결과와 보호 경계

- 상태: 승인됨
- 결정: `run_command` 승인은 정확한 command, canonical cwd, timeout과 foreground 여부에
  묶는다. `/bin/sh -c` child에는 최소 allowlist environment만 전달하고 명백한 파괴 명령과
  공통 민감 저장 경로 접근은 승인보다 먼저 막는다. background는 P12 전에는 시작하지 않는다.
- 결과: 소유 process group을 취소·timeout·합산 출력 상한에서 종료한다. 시작 실패는
  `not_started`, 종료 코드가 확인된 실패는 `failed`, 시작 뒤 강제 종료·상태 유실은
  `unknown`으로 보존하고 부분 stdout/stderr를 제한된 오류 상세로 돌려준다. 이 경계가 임의
  셸 프로그램의 외부 파일·네트워크 접근을 완전히 격리한다고 주장하지 않는다.

## D016 — 단일 실행 소유권과 공통 예산

- 상태: 승인됨
- 결정: process 안의 session별 coordinator가 동시에 하나의 run만 소유한다. owner loop는
  명시적인 상태 전이를 따르고 모델 첫 요청과 transport 재시도가 같은 모델 시도 예산을
  소비한다. wall-clock timer와 caller 취소는 하나의 signal로 하위 경계에 전달한다.
- 결과: provider, 도구, 복구, compaction과 Stop hook은 새 agent run을 만들지 않는다.
  future 기능은 현재 run의 복구·모델·도구 예산 port를 받아야 하며 종료 시 timer와 session
  lease는 각각 한 번만 정리한다.

## D017 — 전체 메시지 fallback과 실행 기록

- 상태: 승인됨
- 결정: native tool call이 하나라도 있으면 text fallback을 해석하지 않는다. text fallback은
  완성된 assistant 메시지 전체가 `call:<등록 이름> <객체>` 문법일 때만 사용한다. 기본은
  표준 JSON이고 relaxed는 profile의 명시적 선택에서만 제한된 비실행 parser를 사용한다.
- 결과: 코드 펜스, 인용문, 설명 속 `call:`과 임의 표현식은 실행하지 않는다. 모든 call ID는
  run 전체에서 중복 확인하고 입력 schema를 먼저 검증한다. 중앙 executor가 handler를 실제로
  시작하는 지점에서 기록을 `started`로 바꾸며 완료·실패·실행 여부 불명 상태를 덮어쓰지 않는다.

## D018 — agent 상호작용과 event 전달

- 상태: 승인됨
- 결정: agent owner는 provider stream, 중앙 executor와 control tool을 순차 loop에서 직접
  연결한다. permission policy와 runner는 동일한 interaction hub를 사용하고, hub가 현재
  run/call ID를 approval·사용자 입력 event에 결합한 뒤 UI decision port로 전달한다.
- 결과: `update_plan`과 연결된 경우의 `request_user_input`만 registry에 등록한다. event sink의
  render 실패는 내부 원장 기록을 없애거나 모델을 재호출하지 않는다. 모든 정상·오류·취소 경로는
  interaction, timer와 session lease를 멱등적으로 정리한 뒤 `run_end`를 한 번 기록한다.

## D019 — 무진전 실행과 교정 복구

- 상태: 승인됨
- 결정: call ID가 달라도 도구 이름과 canonical 입력, canonical 결과가 연속 두 번 같으면
  세 번째 동일 handler를 시작 전에 차단한다. malformed/unknown/schema 오류는 올바른 호출과
  분리하되 같은 run에서 한 번의 교정 feedback만 허용한다.
- 결과: 반복 차단은 `no_progress` terminal reason으로 드러나며 차단된 batch의 handler 예산과
  부작용을 소비하지 않는다. 모든 permission denial은 즉시 run을 끝내므로 대체 도구 우회가
  없다. transport 외부에는 HTTP retry loop를 두지 않고 compaction, Stop hook과 web 복구는
  P05의 공통 extension budget port를 사용해야 한다.

## D020 — append-only 세션 저장과 writer 소유권

- 상태: 승인됨
- 결정: session index와 transcript는 versioned JSONL record로 append하고, reader는
  record·line·page byte와 JSON tree를 모두 제한한 cursor page만 반환한다. session별
  transcript writer는 배타 lock의 무작위 token과 file identity를 수명 동안 보유한다.
- 결과: 손상된 중간 line과 잘린 마지막 line은 원본을 지우지 않고 구분된 경고가 된다.
  stale lock은 PID만으로 제거하지 않으며 metadata update도 같은 transcript writer 소유권을
  요구한다. 저장 전 알려진 secret과 credential field를 redaction하고 trust·credential·승인
  상태는 session schema에 넣지 않는다.

## D021 — 세션 재개·분기의 격리와 rewind 결과

- 상태: 승인됨
- 결정: 영구 resume은 같은 session ID의 provider/profile/model/cwd만 복원하고 권한·관찰·계획
  상태를 초기화한다. no-persistence resume과 모든 fork는 새 session ID를 사용하며 fork에는
  bounded 최근 message/compaction만 다시 기록한다. lifecycle 전환과 rewind는 agent
  coordinator의 session maintenance lease를 소유해야 하며 그동안 새 run 획득도 차단한다.
- 결과: 분기 세션은 parent의 run ID, permission, task, checkpoint 소유권을 얻지 않는다.
  checkpoint rewind는 파일 복원이 완전한 뒤에만 기록을 제거하고 부분 실패를 유지한다. 결과는
  workspace 파일만 대상으로 했음을 표시하며 shell, network와 MCP 부작용 복원을 주장하지 않는다.

## D022 — 저장 transcript와 모델 context projection의 분리

- 상태: 승인됨
- 결정: append-only transcript를 source of truth로 두고 모델에는 bounded projection만 보낸다.
  완전한 tool call/result 쌍은 하나의 unit으로 보존하고 최근 unit부터 선택한다. 현재 실행에서
  신뢰해 주입한 system message만 system role을 유지하며 저장된 system text와 compact summary는
  권한을 가진 지침으로 승격하지 않는다. model context window은 provider metadata, 사용자 설정,
  unknown 순서로 결정한다.
- 결과: 큰 과거 observation은 redaction된 제한형 preview가 되고 불완전한 tool exchange는 실행
  문맥에서 제외된다. 신뢰된 system 지침을 잘라 모델 요청을 계속하지 않으며, context metadata가
  없을 때 임의의 128k 기본값을 가정하지 않는다. compact 완료 record는 원문을 지우지 않는 새
  projection 경계로만 작동한다.

## D023 — 비재귀 compaction과 실패 시 원문 보존

- 상태: 승인됨
- 결정: manual과 auto compaction은 같은 single-pass service를 사용한다. service는 현재 run이
  소유한 extension budget port에서 compaction·공통 recovery와 model request를 소비하고 같은
  retry port와 signal을 provider에 전달한다. 도구 없는 provider stream을 직접 한 번 호출하며
  agent loop를 재귀 호출하지 않는다.
- 결과: 최근 완전한 tool exchange와 bounded continuity만 압축 입력·보존 구간에 포함된다. summary와
  continuity는 historical data이며 system 권한을 얻지 않는다. 완료 후보가 실제로 context를 줄여
  안전한 projection을 만들 때만 append-only 완료 경계를 기록한다. 모든 실패는 원문을 삭제하지
  않는 명시적 stop이고, append 실패 뒤 경계 존재 여부를 확신할 수 없으면 `unknown`으로 드러낸다.

## D024 — 세션 source of truth의 접근·전환 경계

- 상태: 승인됨
- 결정: sessionStore 전체를 일반 파일·foreground shell 도구의 sensitive 경로로 분류한다.
  영구 기록을 메모리 세션으로 재개할 때도 source session maintenance lease를 소유하고,
  metadata 시각은 기존 `updatedAt` 아래로 되돌리지 않는다. 저장·projection redaction은 지나치게
  짧은 secret과 식별자·경고까지 같은 bounded 정책으로 다룬다.
- 결과: 모델이 자기 transcript를 변조하거나 읽는 경로를 기본 도구로 얻지 않는다. 재개 snapshot과
  활성 run이 교차하지 않고, 시계가 뒤로 가도 최신 revision의 시간 순서가 퇴행하지 않는다.
  미완료 tool exchange는 실행 가능한 호출 대신 제한된 redacted notice로 보존한다.

## D025 — alternate-screen 수명주기와 출력 경계

- 상태: 승인됨
- 결정: 대화형 화면은 stdin과 stdout이 각각 TTY일 때만 pi-tui alternate screen을 시작한다.
  stderr의 TTY 여부는 별도로 보존하며 진단은 ANSI 없는 제한된 텍스트로 stderr에만 기록한다.
  화면 구성 요소는 외부 escape와 제어 문자를 제거하는 경계로 감싸고, mouse reporting은 기본부터
  끈다. 시작 일부 실패, render/input 오류와 앱 예외는 모두 하나의 멱등적인 화면 종료 경로를 쓴다.
- 결과: 정상·오류 종료는 대화 내용을 main screen에 다시 출력하지 않고 raw mode, bracketed paste,
  mouse mode, autowrap, cursor와 alternate screen을 복원한다. 화면 오류는 모델 재호출이나 새 agent
  run을 만들지 않으며 실제 터미널별 복원 품질은 정적 검사만으로 확인했다고 주장하지 않는다.

## D026 — 입력 소유권과 비밀 입력 분리

- 상태: 승인됨
- 결정: pi-tui Editor가 Unicode grapheme와 표시 폭, Enter 제출, Ctrl+J newline을 소유하고 cat의
  input controller는 입력·paste·history 총량과 run 중 재제출을 제한한다. busy Ctrl+C는 현재 run의
  cancel port를 한 번만 호출하며 permission/details/session 단축키는 명시적으로 연결된 callback만
  사용한다. API key 등 비밀 입력은 별도 masked overlay component에서만 수집한다.
- 결과: 여러 줄 paste 자체가 submit이나 command dispatch가 되지 않는다. 일반 prompt만 제한된
  history에 들어가며 secret은 getter, transcript, history, clipboard로 노출하지 않고 제출 직후
  화면 redaction 목록에 등록한다. 화면 또는 overlay 종료 시 listener와 secret 보유 상태를 정리한다.

## D027 — 증분 transcript 상태와 scroll 소유권

- 상태: 승인됨
- 결정: transcript는 전체 문자열 대신 제한된 항목 component, assistant message ID, run/call ID와
  단일 현재 plan의 상태로 투영한다. delta와 tool·plan event는 해당 component만 갱신하고, restore는
  bounded 저장 decoder를 통과한 최근 record만 화면 상태로 만든다. 표시 전후와 raw snapshot 모두
  같은 redaction·terminal escape 제거 경계를 사용한다.
- 결과: 항목 수·전체 byte·개별 stream/detail·복원 record·추적 run에 각각 상한이 있다. 새 event는
  사용자의 `ScrollView` follow 상태를 강제로 바꾸지 않아 위로 올린 위치를 유지한다. 완료 전 stream은
  화면 종료 시 redaction된 정적 text로 확정한 뒤 동적 secret 목록을 폐기하며, `/raw` 전환과 사용자가
  요청한 clipboard write는 다음 하위 작업에서만 연결한다.

## D028 — 사용자 주도 복사와 raw terminal 전환

- 상태: 승인됨
- 결정: 기본 TUI는 mouse reporting과 자동 selection copy를 끄고 terminal native selection을 유지한다.
  `/raw`는 TTY·idle 상태에서만 alternate screen을 잠시 벗어나 제한되고 정리된 transcript를 main screen에
  쓰며 네 가지 명시적 복귀 키만 처리한다. 로컬 clipboard port는 user command/selection origin을 요구하고
  write만 제공하며 SSH, OSC52와 tmux를 처리하지 않는다.
- 결과: model text, tool output과 terminal content 자체는 clipboard process나 제어 sequence를 실행할 수
  없다. 로컬 write는 크기·시간·환경·실행 파일과 argv가 제한된 owned child만 사용하고 clipboard read를
  노출하지 않는다. raw 전환과 screen 종료가 겹치면 direct terminal을 먼저 멈춘 뒤 하나의 terminal 복원
  경계로 합류하며, 실제 terminal·desktop별 selection과 clipboard 품질은 런타임 미검증으로 남긴다.
