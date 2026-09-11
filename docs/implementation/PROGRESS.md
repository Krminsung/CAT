# cat 구현 진행 상태

P12 기준 main은 `05a02e75e795e8079b318b2168fc372c50025c7b`이다. 구현은 이 커밋에서
분리된 detached HEAD에서 진행하며 단계 검증이 끝난 뒤에만 정식 브랜치를 만든다.

| 단계 | 상태 | 검증 | 게시 |
|---|---|---|---|
| P01 기반과 실행 계약 | DONE | PASS (1/1) | PR #1 / MERGED `85c68d1` |
| P02 설정·인증·trust | DONE | PASS (1/1) | PR #2 / MERGED `2429b41` |
| P03 provider·transport | DONE | PASS (1/1) | PR #3 / MERGED `3581145` |
| P04 권한·기본 도구 | DONE | 1차 FAIL, 2차 PASS (2/2) | PR #4 / MERGED `b2c3bdb` |
| P05 bounded agent loop | DONE | 1차 FAIL, 2차 PASS (2/2) | PR #5 / MERGED `e5f082a` |
| P06 세션·컨텍스트 | DONE | PASS (1/1) | PR #6 / MERGED `c434311` |
| P07 TUI core | DONE | PASS (1/1) | PR #7 / MERGED `4d91f4a` |
| P08 CLI·명령 | DONE | 1차 FAIL, 2차 PASS (2/2) | PR #8 / MERGED `7d86fdd` |
| P09 확장·hooks | DONE | PASS (1/1) | PR #9 / MERGED `e38ef6f` |
| P10 stdio MCP | DONE | 1차 FAIL, 2차 PASS (2/2) | PR #10 / MERGED `5af2be8` |
| P11 public web | DONE | 1차 FAIL, 2차 PASS (2/2) | PR #11 / MERGED `05a02e7` |
| P12 tasks·worktree·clipboard | IMPLEMENTING | NOT_RUN (0/1) | NOT_PUBLISHED |
| P13 통합·이관·문서 | NOT_STARTED | NOT_RUN | NOT_PUBLISHED |
| P14 배포·설치본 | NOT_STARTED | NOT_RUN | NOT_PUBLISHED |

P01.1은 `50d716d891791fd08e37053bc6032341b575ba84`, P01.2는
`cfed67a6e8cf5e3de36983773a51414a4ca209d8`, P01.3은
`f0e6726bb607dc736b5e245ab4722fb103638e0d`로 완료했다. 전체 diff의 정적 검토와
base 대조를 마쳤다. `55692b2035a4c0585c7b2cb15a1df35df9e3acd0`을 대상으로 한
유일한 `npm run check`가 통과했고 PR #1을 merge commit `85c68d1`로 병합했다.
P02.1은 `5359cfab201cf4dbe3e811167933f82e38614d16`, P02.2는
`3e3326faf8d06499735074d2b231a12d676a3f2a`, P02.3은
`c44fa0c640dbc80960e5ca8d27526f90b1073760`으로 완료했다. 전체 정적 검토에서
확인한 보완은 `60378f41e5dac63a7f6132b38110a3958eb3bbb6`에 묶었다. 기준 main이
변하지 않았음을 확인했다. `0c36e853b21ffee3af2cf5560f418d9e508e5cc2`를
대상으로 한 유일한 `npm run check`가 통과했다.
P02는 PR #2의 검토 head `1416ef4`를 merge commit `2429b41`로 병합했고 tree와
부모 정합성을 확인했다. P03.1 인증된 모델용 bounded HTTP/SSE transport는
`b8b8631c7d520aa1e33d58e38dcfc88c30fcfe0b`로 완료했다. P03.2 Responses adapter는
`ae4e5fe6d311cf570819adfd87a2cbc64b2fa363`로 완료했다. P03.3 Chat-compatible
adapter는 `dd4583343e6c31da05432dc221cec441a5a92c3d`로 완료했다. P03.4의 13개
provider 기본값과 protocol별 capability, adapter factory, bounded model 목록과
독립적인 수동 model ID 검증은 `ba9e9f31696a768efff890745491a7b7d1c42801`로
완료했다. 전체 정적 검토에서 확인한 경계 보완은
`22e77eb5ca0b4e8b054a6737de2c41619f4f077f`에 묶었고, 원격 main이 기준 SHA와
같음을 확인했다. `c88374f7db3598c750e15bbaa51e98fec4820a3d`를 대상으로 한
유일한 `npm run check`가 통과했다. PR #3의 검토 head `e013994`를 merge commit
`3581145`로 병합했고 tree·부모·`origin/main` 정합성을 확인했다. P04는 이 병합
커밋을 기준으로 중앙 tool registry, schema 검증, scope별 permission과 단일 executor
경계를 `79b7d09`로 구현했다. P04.2에서는 canonical path와 민감 alias를 확인하는 guard,
bounded file walk와 UTF-8 구간 읽기, 안전하게 선별한 후보만 처리하는 `rg` 검색 및
별도 process의 bounded fallback을 `652345f`로 구현했다. P04.3에서는 관찰 digest를
확인하는 제한된 파일 변경, 전체 staging을 거치는 patch, 변경 전 상태와 실패를 보존하는
checkpoint·rollback을 `1dffd2d`로 구현했다. P04.4의 정확한 command/cwd 승인 범위,
최소 child environment, 명백한 파괴·민감 경로 접근 차단, 소유 process group의 제한된
foreground 실행은 `009d134`로 완료했다. 전체 정적 검토에서 확인한 승인 객체 불변성,
파일 identity·내용 재확인, 검색 worker와 자식 프로세스 상한, 파괴 명령 판정 보완은
`e7bea7d9a5a52388fecf05b80821a8c8559a1f05`에 묶었다. 원격 main이 기준 SHA와
같음을 확인한 뒤 `c31e862179516070f88738fa0004d7b5b75e277b`를 대상으로 예약한
유일한 `npm run check`를 실행했다. 검사는 `src/process/child-process.ts`의 spawn
stdin 타입과 선택 속성 구성에서 엄격 타입 오류 2개를 보고하고 종료 코드 2로
실패했다. 사용자가 P04 오류 수정과 `npm run check` 추가 1회를 명시적으로 승인해,
보고된 두 타입 오류만 `76917b48663f2cb90f78ad29012588820b69dffb`에서 수정했다.
첫 실패 기록을 보존한 채 `cc7ac1ea55fc9370537b6b944988add2ccfb1834`를 대상으로
두 번째이자 마지막 승인 검사를 실행했고 통과했다. 결과는 정적 검사 통과이며 실제
파일 작업, child process와 앱 런타임은 검증하지 않았다.
P04는 검토 head `dec139826157fa12b2b6aeb0a001c80469392c3f`를 PR #4에서 merge
commit `b2c3bdb562c1a67d4191fec17bfd04a5f0e41663`로 병합했다. merge의 두 부모,
tree, phase head의 조상 관계와 `origin/main`을 대조했다. P05는 이 merge commit을
기준으로 단일 소유 실행 상태와 공통 예산을 `1019420`으로, 호출 정규화와 실행 원장을
`e6f13bb`로 구현했다. 제어 도구·상호작용 event와 실제 provider→executor 흐름은
`16bd113`에 연결했고, 무진전 반복과 무제한 malformed-call 교정 차단은 `88591bf`로
완료했다. 전체 정적 검토에서 확인한 provider·agent event 상한, native 호출 고정,
fallback prefix의 선형 처리와 종료 전 자원 정리는
`552d8ae8bd0788f87c5f5c27438fdf16c3a01363`에 묶었다. 원격 main이 기준 SHA와
같음을 확인한 뒤 `23f8443c06274da36012d31a0d7222d844d5e3dc`를 대상으로 예약한
유일한 `npm run check`를 실행했다. 검사는 `src/agent/runner.ts:319`에서 catch 변수
`error`가 `unknown`인 엄격 타입 오류 TS18046을 보고하고 종료 코드 2로 실패했다.
사용자가 P05 오류 수정과 `npm run check` 추가 1회를 명시적으로 승인해, 보고된 타입
오류만 `ed1ecf73bb18cbd618bda2574d6b1daeeec5e16e`에서 수정했다. 첫 실패 기록을
보존한 채 `1e99d7a99ec3a96042eec2de186953e99add33bd`를 대상으로 두 번째이자
마지막 승인 검사를 실행했고 통과했다. 결과는 정적 검사 통과이며 실제 provider,
agent loop, 도구와 앱 런타임은 검증하지 않았다. P05는 검토 head
`d9f9a87195fe9507f50f1f5989958cab9d3983d5`를 PR #5에서 merge commit
`e5f082a0b8ccb5fdc70233837762941e63f7233b`로 병합했다. merge의 두 부모, tree,
phase head의 조상 관계와 `origin/main`을 대조했다. P06은 이 merge commit을 기준으로
bounded JSONL 세션 저장을 `6ad083a2fea6ba881b2c7c754c38cbebc0df90fc`에서 구현했다.
paging된 source transcript에서 대화 기록만 새 ID로 상속하는 new/resume/continue/fork,
메모리 전용 no-persistence, metadata 변경과 소유권 기반 rewind는
`058e6bda00e74bdd3c0abcb0abe0815a47882b0a`에서 연결했다. 현재는 완전한 tool call/result
쌍과 최근 대화를 우선하는 bounded model context projection, provider metadata 우선 context
window과 자동 compact threshold, 활성 run과 교차하지 않는 transcript scanner를
`23a4c410d5c409f38a9e181a300c2c9428aa2e94`에서 구현했다. 현재는 같은 run의 recovery,
compaction, model request와 transport retry 예산을 받는 비재귀 manual/auto 압축, bounded
continuity 보존과 append-only 완료 경계를
`fb238f43693e6237bc94db01403d6d97de4ba821`에서 연결했다. 전체 정적 검토에서 짧은 redaction
secret, no-persistence resume의 maintenance 소유권, metadata 시각 단조성, sessionStore의 도구
접근 차단, projection 식별자·경고 redaction과 compaction 손실성 표기를
`e50f0a5368f6c12a01bc719cd0f96494b2a86b3e`에서 보완했다. 추적된 원본 archive·build
산출물·secret·GitHub Actions workflow와 검사 우회는 발견되지 않았다. `origin/main`이 P06
기준 SHA와 같음을 확인한 뒤 `13908a0e1743d632734b8673d097b3f5ab44662c`를 대상으로
예약한 유일한 `npm run check`를 실행했고 통과했다. 실제 세션 I/O, rewind, 모델 압축, 도구와
앱 런타임은 실행하지 않았다.
P06는 검토 head `5a0b32ed50faf6d32cd064052999039e71d44135`를 PR #6에서 merge
commit `c434311e79ac2c112ea8ac08e31b5a320dff3e2f`로 병합했다. merge의 두 부모,
tree, phase head의 조상 관계와 `origin/main`을 대조했다. P07은 이 merge commit을 기준으로
alternate-screen 화면 수명주기와 TTY·복원 경계를 구현하고 있다.
P07.1의 alternate-screen layout, 독립 TTY 판정, 제어 문자열 정리와 멱등 복원 경계는
`2e8aa99595b31db0cdcb97fd706e017afcc49d8c`에서 완료했다. P07.2의 bounded Unicode editor,
paste·단축키·history controller와 일반 기록에서 분리된 masked secret overlay는
`98528d984f6a999893c05b7d9dbd67328a10f809`에서 완료했다. P07.3의 항목별 stream projection,
동일 ID tool·plan 갱신, 제한된 resume 표시와 사용자 scroll 보존은
`b2219403e6d58901861a2186faf462af9cbf7d3b`에서 완료했다. P07.4의 native selection 유지,
제한된 raw transcript 전환과 사용자 주도 로컬 clipboard abstraction은
`996f1fb9e177163c12e763a607779d550b87e72c`에서 완료했다. 현재 P07 전체 정적 검토에서 확인한
출력 redaction 순서, 최근 raw 기록, 입력·secret·clipboard 수명과 탐색 상한은
`849ef8988b20707f58b27a68e76e43548d77c4a2`에서 보완했다. agent→TUI 역의존, 검사 우회,
추적된 원본·산출물과 자동 clipboard 경로가 없음을 확인했다. 이후
`d84c19edc683d5d64485aad650ad9eb1f9140d17`을 대상으로 예약한 유일한
`npm run check` 1회를 실행했고 통과했다. 실제 terminal·clipboard 런타임은 실행하지 않았다.
P07은 검토 head `2f7df0ef1fb1b02277a16c9df537722104206070`을 PR #7에서 merge
commit `4d91f4a4716831a488c3ebb4ed0d94e95cc06070`으로 병합했고 두 부모·tree·조상 관계와
`origin/main` 포함을 확인했다. P08은 이 merge commit을 기준으로 bounded argv와
text/json/stream-json 출력 경계를 `8e468a6b7c8326fbb70a215116f241d40fedc189`에서 구현했다.
정확히 28개 명령 정의에서 capability 기반 help·완성·dispatch를 파생하는 registry는
`dc6413a944583827ce6363397e62348f72a6c244`에서 완료했다. model/provider/profile/session,
권한·질문·승인과 config/cost/status용 bounded overlay, masked API key 입력과 secret 없는
`auth setup/status/use/remove` 관리 흐름은 `eea1fd73a083e53550a4fb09856bbcda005f8214`에서
완료했다. session 선택→trust→설정→인증된 provider/model→bounded context와 agent
run→transcript 저장→화면·session·transport 종료를 조립하고, `@file`과 `!`를 중앙 도구 경계에
연결한 P08.4는 `ec76acc1a99c564d33c7467c9aa2d4a5f69c2f8c`에서 완료했다. 전체 정적
검토에서 확인한 명령별 help, provider/model 전환 순서, 구조화/TUI 민감 field redaction과
큰따옴표 속 background 연산 차단은 `a1eb310fa94c9b96a2dd1eb5c0d32b750fd84526`에서
보완했다. agent→TUI 역의존, 중앙 executor 우회, 검사 script 변경, 추적된 secret·원본·산출물과
GitHub Actions workflow가 없음을 확인했다. `origin/main`이 P08 기준 SHA와 같음을 대조한 뒤
`c76275d79568d75d7253b25a52e564168d7a06ef`을 대상으로 예약한 유일한 `npm run check`를
실행했다. 검사는 `src/app/application.ts`에서 barrel export 누락 TS2305 2개, system message
타입 불일치 TS2345 2개와 암시적 `any` TS7006 1개를 보고하고 종료 코드 2로 실패했다. 사용자가
P08 오류 수정과 `npm run check` 추가 1회를 명시적으로 승인해, 보고된 진단만
`9c7eb3a5c228209c4f8c724ccc90360dca369648`에서 수정했다. 첫 실패 기록을 보존한 채
`b3d39d85cf8790a7c6ae4d5290086e3a8f0cdf40`을 대상으로 두 번째이자 마지막 승인 검사를
실행했고 통과했다. 결과는 정적 검사 통과이며 앱·TUI·provider·session·도구 런타임은
실행하지 않았다.
P08은 검토 head `ea3d36304e4144bce323a100680edb32df23d379`을 PR #8에서 merge
commit `7d86fdd05dbb3387008e2c81ef8a25f0a0f3920f`으로 병합했다. merge의 두 부모,
tree, phase head 조상 관계와 `origin/main` 포함을 확인했다. P09는 이 merge commit을 기준으로
전역 지침과 신뢰된 프로젝트의 root→cwd 지침을 우선순위대로 선택하고, `@path` include의
canonical 경계·중복·순환·깊이·파일 수·전체 byte 상한을 강제하는 P09.1을 구현하고 있다.
P09.1은 `a84e9ceb400927cc6d70bbd8199aa1067890b6e0`에서 완료했다. 이어서 확장 본문을
지연 로드하는 skill·Markdown command catalog, built-in 충돌 차단, catalog 이름으로만 조회하는
`load_skill`과 bounded positional argument 렌더링을 P09.2에서 구현하고 있다.
P09.2는 `173ee09750350d30c238f89a1a09dd87e3eaa334`에서 완료했다. P09.3에서는 정확히
8개 event, 세 blockable event의 exit code 2 의미, 최소 환경, bounded JSON stdin·통합 output·추가
context, timeout·abort·process group 정리와 engine 재진입 차단을
`dd4851e591e985295f48df2209fe14bbd3abcd00`에서 완료했다. P09.4에서는 지침·skill catalog와
SessionStart/UserPromptSubmit context를 권한 없는 비신뢰 모델 입력으로 연결하고, 중앙 executor의
Pre/Post hook, 공유 budget의 Stop continuation 1회, PreCompact와 세션 전환·종료 event를 조립하고 있다.
`/init`과 `# instruction`은 canonical 파일 관찰·중앙 write 경계를 사용하며 `/reload`는 기존 인증과
승인을 보존한 채 검증된 설정·지침·command·skill·hook만 교체한다. P09.4는
`ff926674da37a39d7105298b8af37a6a26b6bde2`에서 완료했다. 전체 정적 검토에서는 기본 지침 선로딩과
notice 수를 파일 32개·알림 256개 경계 안으로 제한하고, lazy extension을 catalog 시점과 같은
device·inode·size·mtime·ctime의 파일로만 읽도록 보완하고 있다. 지침·extension read 전후의 canonical
경로와 identity, `O_NOFOLLOW`를 재확인하며 긴 skill catalog는 완전한 이름 행만 모델에 제공한다.
이 보완은 `1805cae3e60378311cb18694140b2a11bc924050`에서 확정했다. base부터 전체 diff, trust 이후
process 순서, 중앙 permission과 추가 deny, 공유 Stop budget, 8개 event 연결, dependency 방향과 추적
파일을 정적으로 대조했다. `origin/main`은 P09 기준 SHA와 같고 자동 검증은 아직 실행하지 않았다.
`5a28f9e1bfbd54bfb2784ce7a06ccb9e3cf01618`을 검사 대상으로 예약한 뒤 P09에서 허용된 유일한
`npm run check`를 실행했고, 2026-09-10T13:19:27+09:00부터 약 1.49초 뒤 exit 0으로 통과했다.
검사는 `tsc -p tsconfig.json --noEmit`만 수행했으며 앱, TUI, provider, 도구, 실제 hook·extension
runtime과 원본 script는 실행하지 않았다.
P09는 검토 head `4033ba63f9cafd576338808b7522b03fbd22012f`를 PR #9에서 merge
commit `e38ef6fa490d8e337042c289f167a5bb438b7fad`로 병합했다. merge의 두 부모,
tree, phase head 조상 관계와 `origin/main` 포함을 확인했다. P10은 이 merge commit을 기준으로
MCP protocol 의미와 분리된 bounded stdio transport를 구현하고 있다. 소유 child process의
newline frame·pending request·stderr tail·timeout/abort/exit 정리와 stdin close→TERM→KILL
종료 순서를 P10.1에 둔다.
P10.1은 `0c713c2cd5d4415c678538202d21e29b3252b63a`에서 완료했다. P10.2에서는 legacy
initialize lifecycle과 modern per-request metadata를 별도 adapter로 분리하고, page·entry·cursor·누적
metadata 상한과 결정적 tool namespace를 구현하고 있다. 재연결 뒤 늦은 이전 child event가 새
transport 상태를 덮지 않도록 process identity도 listener에서 다시 확인한다.
P10.2는 `fbf6fcb2108e2653b9e03268d631bdefd3d22cb0`에서 완료했다. P10.3에서는
JSON Schema 2020-12의 bounded subset과 문서 내부 참조만 허용하고, 정확히 고정한
`ajv@8.20.0`으로 provider와 독립적인 입력 validator를 준비한다. 검증할 수 없는 schema는 해당
동적 도구를 비활성화하며, MCP 도구 이름만으로 이전 승인을 재사용하지 않도록 server registry
version이 든 external permission 계약과 원자적 registry 교체 경계를 구현했다.
P10.3은 `a4a2161c17d61cc89482b27d63c555612faf7d22`에서 완료했다. P10.4에서는 계층형
MCP 설정과 environment secret reference, 설정 저장과 process 시작의 분리, exact execution plan을
사용하는 manager를 연결하고 있다. 세 관리 built-in과 CLI list/get/add/remove, `/mcp [reconnect]`,
동적 도구의 host schema·central permission 실행 경로, reload·세션 전환·앱 종료 cleanup을 포함한다.
workspace와 cwd identity를 승인 뒤에도 재확인하고, 종료 확인 실패·분기/reference schema 복잡도·
민감한 MCP 출력 field에 대한 fail-closed 보완도 함께 적용했다. P10.4는
`c7fcf0d4d4f5ceecf50e3e3c335acd0d92b70ede`에서 완료했다. 전체 정적 검토에서 schema가 아닌
annotation data를 가리키는 reference와 모호한 URI 인코딩을 차단하고, 민감 출력 field 이름 정규화,
설정 문자열의 Cc/Cf 거부, transport command·cwd byte 상한과 stderr stream 오류 정리를 보완하고
있다. 이 보완은 `dd0c1f4923fc36a1382c535b339084f434aca34a`에서 확정했다. dependency 방향,
중앙 executor·승인 경계, 추적 파일과 `origin/main`을 대조했으며 자동 검증과 실제 MCP·앱 runtime은
실행하지 않았다. 이전 예약 문서가 코드 commit과 `0 / 1`을 검사 대상으로 기록했지만, 기준 문서
3.3의 선예약 규칙에 맞춰 명령 실행 전에 `1 / 1`로 정정하고 이 예약 정정 기록 commit 자체를 유일한
검사 대상으로 삼았다. 사용자가 P10의 `npm run check` 1회를 승인해
`c3ff9690bffec738a8c5b9553a844e025d28bca4`에서 실행한 검사는 `src/mcp/schema.ts`의
Ajv 2020 import에 대해 TS2709와 TS2351을 보고하고 종료 코드 2로 실패했다. 추가 검사, source 수정,
push, PR과 merge는 진행하지 않았다. 이후 사용자가 P10 오류 수정과 `npm run check` 추가 1회를
명시적으로 승인해, 보고된 Ajv import 진단만
`472010295edcab81fb52992ffe5931b3b7d2740f`에서 수정했다. 첫 실패 기록을 보존한 채 두 번째이자
마지막 승인 검사를 `0faa676b25c301924aaab63191ddacfe0ba09a48`에서 실행했고 종료 코드 0으로
통과했다. 검사는 `tsc -p tsconfig.json --noEmit`만 수행했으며 실제 MCP server·앱·TUI와 원본
script·test runtime은 실행하지 않았다.
P10은 검토 head `1f1c5d5427dd58f655a9ca4477f1a71d91026ed4`를 PR #10에서 merge commit
`5af2be849c07b8a2752772ce73c090c662a9e008`로 병합했다. merge의 두 부모, tree, phase head
조상 관계와 `origin/main` 포함을 확인했다. P11은 이 merge commit을 기준으로 인증된 model HTTP와
분리된 public web transport를 구현하고 있다. URL·DNS 결과·redirect와 실제 socket remote address를
확인하고, 검증한 주소만 반환하는 per-hop lookup을 사용한다. 환경 proxy는 fail closed하며 전체
deadline, wire·해제 body, header·chunk·동시 요청과 종료 cleanup 상한을 P11.1에 둔다.
P11.1은 `bef6aebfa5b85730529ba72ac093c1db1f91c3c5`에서 완료했다. P11.2에서는 알려진
credential과 민감 environment를 갱신 가능한 public input guard에서 제거하고, 민감 query parameter가
포함된 fetch URL은 fail closed한다. 원본의 Bing reader→DuckDuckGo reader→Bing HTML 순서를 각각 한
번만 시도하는 `web_search`와 textual response를 실행 불가능한 제한형 텍스트로 만드는 `fetch_url`을
중앙 public network 도구로 등록하고 있다. 결과에는 추출한 실제 source URL과 backend final URL을
남기며 전체 provider 실패, 정상 응답의 결과 없음과 실제 결과를 서로 다른 상태로 보존한다. 앱 종료와
조립 실패는 model transport와 별도로 public transport cleanup을 수행한다. 외부 요청과 자동 검증은
실행하지 않았다. P11.2는 `a0668271719e29471759d6adec74b1d88720f1a5`에서 완료했다. P11.3에서는
원 prompt만 사용하는 최신 정보·명시적 검색·web 금지·민감/로컬 context 정책을 runner에 연결하고
있다. host가 정리한 query와 사용자 URL·실제 검색 결과·페이지 link 후보만 외부 도구 입력으로 허용하며,
검색 1회와 URL별 1회 경계를 둔다. 검색 snippet이 아니라 관련 `fetch_url` 원문과 실제 final URL 인용을
완료 근거로 추적하고, 빠진 근거는 동일 run의 공통 예산에서 web 복구 한 번으로만 보완한다. 공개 page는
비신뢰 data로 전달하며 근거 없는 초안은 노출·message 기록하지 않고, 복구 뒤에도 근거가 없으면 host
제한 문구로 끝낸다. 위치 없는 날씨 요청은 host 위치를 추론하거나 외부 요청하지 않고 지역을 다시 묻는다.
P11.3은 `23bcbcf5ea905e8e9dd59e7776edc3cd7e317d02`에서 완료했다. 전체 정적 검토에서는 TLS
인증서 identity와 body abort, 반복 percent encoding secret, HTML·검색 parser 총량, 실제 검색 source
선별, 민감·금지·모호한 query 및 후속 prompt, 웹 응답 보류·host 제한 문구와 권한 거부 뒤 우회 차단을
보완했다. 이 보완은 `74d6c1b367d5260ad0e9144167b80960c8d130ad`에서 확정했다. base부터 전체
diff의 기능·의존성·권한·취소·secret·출력·정리 경계와 추적 파일을 대조했고 `origin/main`은 P11 기준
SHA와 같다. 외부 URL, 앱·도구 runtime은 실행하지 않았다. 사용자가 P11의 `npm run check` 1회를
명시적으로 승인해 예약 commit `62705bd401fe209ae48343c535ee01a0dd9a2ab2`에서 실행한 검사는
`src/app/application.ts:1824`의 capability 허용 타입에 `web`이 없는 TS2322와
`src/web/evidence.ts:78`의 message narrowing 관련 TS2339·TS7006을 보고하고 종료 코드 2로
실패했다. 추가 검사, source 수정, push, PR과 merge는 진행하지 않았다. 이후 사용자가 P11 오류
수정과 `npm run check` 추가 1회를 명시적으로 승인해, 보고된 capability와 message narrowing 진단만
`ebc48788ee8bd5672b7367bc36ef480a57d27671`에서 수정했다. 첫 실패 기록을 보존한 채 두 번째이자
마지막 승인 검사를 `4ff679eab63a88805392e62d5cb51d1230cab295`에서 실행했고 종료 코드 0으로
통과했다. 검사는 `tsc -p tsconfig.json --noEmit`만 수행했으며 실제 외부 검색·URL, 앱·TUI와 web
도구 runtime은 실행하지 않았다.
P11은 검토 head `638fcfee9379ca4a5008829351e7449ba53ee034`를 PR #11에서 merge commit
`05a02e75e795e8079b318b2168fc372c50025c7b`로 병합했다. merge의 두 부모와 head/merge의
동일 tree, phase head 조상 관계, `origin/main` 포함을 확인했으며 병합 뒤 검사는 반복하지 않았다.
P12는 이 merge commit을 기준으로 시작했다. P12.1에서는 foreground timeout과 분리된 background
deadline, 중앙 승인과 workspace identity 재검사, session별 ID 소유권, 8MiB disk-backed 원형 tail,
작업 수·수명·복원 scan 상한과 TERM→KILL 종료 경계를 구현하고 있다. 종료를 확인하지 못한 persisted
task는 재개 시 `stale`로 보존하되 PID를 추측하거나 signal하지 않으며, 현재 manager가 만든 child만
session/app cleanup 대상으로 삼는다. list/output/stop 도구도 같은 session과 승인된 task identity에
묶었다. P12.1은 `b7d78eb02eec6f77509c68127fd35d2c638729b7`에서 완료했다. P12.2에서는
Git common directory의 canonical path·device·inode로 분리된 보호 registry에 cat이 직접 생성한
worktree만 기록하고 있다. 생성은 registry 예약 뒤 path·branch·filesystem identity를 확인하며,
제거는 현재 cwd, identity 불확실·변경, locked·bare·prunable 및 tracked·untracked·ignored 변경을
거부하고 force·prune·branch 삭제를 제공하지 않는다. CLI add/list/remove와 `-w`, `/worktree`를
연결하고 새 cwd의 trust 범위를 다시 해석한다. 실제 셸·task, Git worktree, 앱과 검증 명령은 실행하지
않았다. P12.2는 `e72579c98e997127a6565ea57b86c2c088c9a193`에서 완료했다. P12.3에서는
명시적 `/raw copy`에서만 로컬 clipboard 뒤 host 생성 OSC52를 사용하고 tmux/screen wrapping을
지원한다. 로컬 TTY에서 사용자가 직접 시작하는 `cat-tui ssh`는 OpenSSH option을 shell 없는 argv로
전달하고, stdout/stderr의 OSC·DCS류 문자열을 bounded parser로 제거한 뒤 제한된 OSC52 write만
처리한다. clipboard read는 응답하지 않으며 canonical base64·UTF-8·크기·횟수·queue deadline과
owned process group 종료 상한을 적용한다. 실제 SSH/PTTY, clipboard와 앱은 실행하지 않았다.
P12.3은 `d6c9e36cfa740891c51adf361b1371376308b71f`에서 완료했다. P12.4에서는 `/tasks` 목록·출력·중지를
중앙 task 도구와 permission 경계로 연결하고 `! command &`가 foreground timeout 대신 background
deadline만 사용하도록 고쳤다. session별 active·unconfirmed 개요와 bounded 변경 listener로 header와
`/status`를 갱신하며 non-terminal task는 제한된 compaction continuity에만 남긴다. 목록 command와
오류, 상세 output은 별도 표시 상한을 사용한다. 종료 중 다른 service나 session 기록이 실패해도 현재
manager 소유 task cleanup을 이어가고 미확정 상태를 성공으로 숨기지 않는다. 실제 task, shell, 앱과
검증 명령은 실행하지 않았다.
