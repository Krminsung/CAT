# cat

`cat`은 작업공간을 읽고 수정하고 명령을 실행할 수 있는 bounded 터미널 코딩 에이전트다.
대화형 TUI와 한 번 실행하는 CLI, API-key-only provider profile, 세션 기록, 권한 확인, MCP,
공개 웹 도구, background task와 managed Git worktree를 한 실행 경계 안에서 관리한다.

> 검증 범위: 로컬 모의 API와 실제 터미널 입력으로 custom 초기 설정, Chat/Responses 첫 응답,
> 설정 재사용, 입력 오류·취소와 연결 전환을 확인한다. 실제 외부 provider와 웹·MCP·SSH 등의
> 전체 기능 검증과는 구분하며, 실행 결과는 `docs/implementation/phases/P14-R08.md`에 기록한다.

## 설치와 현재 배포 상태

공개 GitHub Release의 최신 Linux 설치본은 다음 한 줄로 CPU architecture 판별, 다운로드, checksum
검증과 설치까지 진행한다. root shell에서 실행하면 root HOME에 설치한다.

```bash
curl -fsSL https://raw.githubusercontent.com/Krminsung/CAT/main/install.sh | sh
```

이 bootstrap은 GitHub의 최신 정식 Release만 사용하며 installer와 같은 Release의 SHA-256 sidecar를
검증한다. 설치본 검증은 Linux x64의 격리된 사용자 설치 경로와 로컬 모의 API를 대상으로 하며,
외부 provider 전체나 다른 서버 환경의 호환성을 보증하지 않는다.

소스 checkout의 필요 조건은 Node.js `22.19.0` 이상과 npm이다. 다음 순서로 고정 dependency를 설치하고
TypeScript를 컴파일한 뒤 내부 launcher를 사용할 수 있다.

```bash
npm ci
npm run build
./bin/cat --help
```

standalone installer source도 포함하지만 생성 결과인 `artifacts/`는 Git에 넣지 않으며 npm registry나
GitHub Release에 자동 공개하지 않는다. 최종 source를 한 번 컴파일한 뒤 별도 packaging 명령은 기존
`dist/`만 소비해 Linux x64/arm64 설치본과 SHA-256을 만든다.

```bash
npm run package:installer
```

설치본은 공식 Node.js v24.21.0, production dependency, `bin/cat`과 license 자료를 포함한다. artifact
검증·설치, 기본 사용자 경로, update/rollback과 `cat` 충돌 정책은
[`docs/release/INSTALL.md`](docs/release/INSTALL.md)를 따른다. 입력과 재현 범위는
[`docs/release/REPRODUCIBILITY.md`](docs/release/REPRODUCIBILITY.md)에 기록했다.

standalone installer는 일반 사용자뿐 아니라 root shell 또는 `sudo -H` 실행도 지원한다. root 설치본을
root로 실행하면 cat이 시작하는 명령도 UID 0 권한을 가지며, `full-auto`여도 cat 내부 hard deny는
유지된다. 시스템 전체 변경 위험이 있으므로 격리된 서버에서만 root 실행을 사용한다.

이 문서의 나머지 예시는 설치 후 기본 PATH 이름인 `cat-tui`를 사용한다. source checkout에서는 이를
`./bin/cat`으로 바꿔 실행한다. Unix 기본 명령과 충돌하는 `cat` PATH link는 설치 시
`CAT_INSTALL_CAT_COMMAND=1`을 명시했을 때 user-bin 안에서만 시도한다.

## 빠른 시작

먼저 대화형 TTY에서 API key profile을 만든다. API key는 화면에 표시하지 않는 입력 창으로 받는다.

```bash
cat-tui auth setup --provider openai --profile openai --model MODEL_ID
cat-tui auth status
```

작업할 폴더에서 TUI를 연다.

```bash
cat-tui -C /absolute/path/to/project
```

읽기 중심의 한 번 실행은 다음처럼 요청할 수 있다.

```bash
cat-tui -p -C /absolute/path/to/project --permission-mode plan \
  "이 프로젝트 구조를 설명해 주세요"
```

`--print`에서는 필요한 사용자 승인을 새로 받을 수 없다. 기본 `ask` 모드에서 승인 대상인 편집·명령
등은 실행되지 않으므로, 비대화형 자동화에서는 권한 모드와 도구 범위를 명시적으로 검토해야 한다.

## API key와 provider profile

지원 provider ID는 다음 13개다.

`internal`, `openai`, `anthropic`, `google`, `openrouter`, `xai`, `groq`, `deepseek`, `mistral`,
`together`, `cerebras`, `fireworks`, `custom`.

```bash
# 저장된 profile 확인
cat-tui auth status

# 활성 profile 변경
cat-tui auth use PROFILE

# profile과 더 이상 쓰이지 않는 연결 credential 제거
cat-tui auth remove PROFILE
```

`custom` provider에는 HTTPS base URL과 protocol을 함께 지정한다.

초기 provider 선택 화면과 `/connect custom [profile]`에서도 서버 주소, 통신 방식과 API key를
순서대로 입력할 수 있다. 잘못된 주소는 같은 화면에서 수정하고 Esc로 provider 선택에 돌아간다.
모델 목록을 지원하지 않거나 조회가 실패하면 모델 ID를 직접 입력할 수 있다.

```bash
cat-tui auth setup \
  --provider custom \
  --profile my-api \
  --base-url https://api.example.com/v1 \
  --protocol openai-chat \
  --models-path /models \
  --response-path /chat/completions \
  --model MODEL_ID
```

HTTP endpoint는 내부 개발 환경에서 `--allow-insecure-http`까지 명시한 경우에만 허용된다. OAuth,
브라우저 로그인, 구독 cookie는 지원하지 않는다. 저장 credential은 OS keychain이 아니라 권한을 제한한
`CAT_HOME/credentials.json`의 plaintext API key이므로, 해당 파일과 backup을 비밀로 취급해야 한다.

선택한 profile이 이미 존재하면 `CAT_API_KEY` 또는 해당 provider의 표준 API key 환경변수로 저장 key를
실행 중에 덮어쓸 수 있다. 환경변수만으로 새 endpoint/profile을 만들지는 않는다. 여러 호환 환경변수의
값이 서로 다르면 실행을 거부하므로 `CAT_API_KEY`를 명시하거나 충돌을 제거해야 한다.

## CLI 사용법

전체 옵션은 `cat-tui --help`, 관리 명령별 옵션은 `cat-tui COMMAND --help`에서 확인한다.

| 목적 | 예시 또는 옵션 |
|---|---|
| 대화형 실행 | `cat-tui [-C DIRECTORY] [prompt]` |
| 한 번 실행 | `cat-tui -p [--output-format text\|json\|stream-json] prompt` |
| 최근 세션 재개 | `cat-tui -c` |
| 지정 세션 재개 | `cat-tui -r SESSION_ID` |
| 새 managed worktree에서 실행 | `cat-tui -w [NAME]` |
| provider/model 선택 | `--provider ID --profile NAME --model ID` |
| turn 상한 | `--max-turns 1..100` |
| 권한 모드 | `--permission-mode ask\|auto-edit\|full-auto\|plan` |
| 노출 도구 선택 | `--tools default` 또는 쉼표로 구분한 도구 이름 |
| 추가 허용·항상 차단 | `--allowed-tools ...`, `--disallowed-tools ...` |
| 세션을 저장하지 않음 | `--no-session-persistence` |
| 프로젝트 사용자 설정 신뢰 | 검토 후 `--trust-workspace` |
| 출력 조정 | `--verbose`, `--no-color` |

전체 작업에는 고정 실행 시간 제한이 없으며, 계획 진행이나 승인 대기를 포함해 10분이 지났다는
이유만으로 중단하지 않는다. 개별 API 요청·도구의 timeout, 사용자 취소와 turn·모델 요청·도구 호출·
복구 횟수 제한은 그대로 적용된다. JSON 결과의 `budget.deadlineAt`은 시간 제한이 없음을 뜻하는 `null`이다.

`--resume`과 `--continue`, 그리고 이 둘과 `--worktree`는 함께 사용할 수 없다. `json`과
`stream-json` 출력은 `--print`에서만 사용할 수 있다. 비밀값이 여러 토큰에 나뉘어 노출되는 것을 막기 위해
텍스트는 완성된 `text_complete` 이벤트에서 전체 redaction 후 전달한다. 원시 `text_delta`는 TUI의
일시적인 표시에만 사용하며 JSON stdout과 세션 이벤트 기록에는 남기지 않는다. 이벤트 sequence에는
생략된 delta로 인한 간격이 있을 수 있다. 중단된 미완성 응답은 JSON 텍스트 이벤트로 내보내지 않는다.
`--base-url`은 선택한 저장 profile의 endpoint와
일치하는지 확인하는 옵션이지, 임시 credential을 만드는 옵션이 아니다.

관리 명령은 agent 대화와 별도 진입점이다.

```text
cat-tui auth <setup|status|use|remove> ...
cat-tui mcp <list|get|add|remove> ...
cat-tui worktree <add|list|remove> ...
cat-tui ssh [OpenSSH options] user@host [remote command]
cat-tui migrate [--source DIRECTORY] [--include-credentials]
```

`mcp add`는 stdio server 설정만 저장하며 process를 시작하지 않는다. 실제 연결은 신뢰된 대화형
세션에서 `/mcp reconnect`를 선택하고 외부 실행 승인을 받은 뒤 이루어진다. 지원 protocol version은
`2025-11-25`와 `2026-07-28`이다.

`worktree remove`는 cat이 만든 clean worktree만 제거한다. tracked, untracked, ignored 변경이 있으면
거부하고 branch는 삭제하지 않는다. `ssh`는 시스템 OpenSSH 인증과 host-key 처리를 그대로 사용하면서
원격 clipboard 쓰기만 제한적으로 중계하며 clipboard 읽기 요청은 차단한다.

## TUI

새 대화는 고양이 ASCII 아트와 빠른 시작 안내로 열리고, 머리글에는 긴 세션 ID 대신 대화 제목을
우선 표시한다. 제목은 첫 요청에서 자동으로 만들며 `/rename 새 제목`으로 변경할 수 있다.
사용자 요청은 `나 · 요청`, 답변은 `CAT · 응답` 테두리로 나누고 사용자 영역을 별도 색상으로 강조한다.

입력창 바로 위에는 작업 중 움직이는 로딩 표시, 현재 처리 단계, 경과 시간과 `Ctrl+C` 취소 안내가
고정된다. 답변 문장이 끝나도 도구 실행·다음 모델 응답·결과 정리가 끝날 때까지 진행 표시를 유지한다.
완료·취소·중단은 서로 다른 문구로 표시한다. 경과 시간 표시는 실행 제한이 아니다.

권한·선택 창은 대화 배경을 완전히 가리는 패널이다. `↑`/`↓`로 선택하고 `Enter`로 확인하며,
긴 실행 설명은 `Page Up`/`Page Down`으로 읽는다. 선택지와 확인 안내는 본문 스크롤과 분리된다.
너무 작은 창에서는 크기 안내를 표시하고 보이지 않는 선택을 Enter로 승인하지 않는다.
`--no-color` 또는 `NO_COLOR` 환경변수로 색을 끄더라도 테두리와 역할 이름은 유지된다.

TUI의 기본 입력 동작은 다음과 같다.

| 입력 | 동작 |
|---|---|
| `Enter` | 현재 입력 제출 |
| 실행 중 `Ctrl+C` | 현재 요청 취소 요청 |
| 대기 중 `Ctrl+C` | 편집기 입력 지우기 |
| 빈 입력에서 `Ctrl+D` | 세션을 닫고 종료 |
| `Shift+Tab` 또는 `Alt+M` | 권한 모드 순환 |
| `Ctrl+O` | 도구·계획 상세 표시 전환 |
| `Ctrl+P` | 세션 선택 화면 |

입력과 붙여넣기는 byte 상한과 terminal sequence 정리를 거친다. API key는 별도의 masked 입력을 쓰며,
선택 창은 `Enter`로 확정하고 `Esc`로 취소한다. `/raw`는 현재 대화를 제한된 복사 보기로 열고,
`/raw copy`는 지원되는 clipboard 경로에 명시적으로 복사한다.

내장 slash 명령은 정확히 28개다.

```text
/help       /new        /clear       /compact     /config      /cost
/details    /diff       /exit        /fork        /init        /memory
/mcp        /connect    /disconnect  /model       /models      /provider
/permissions /raw       /rename      /reload      /resume      /sessions
/rewind     /status     /tasks       /worktree
```

각 명령의 현재 사용법은 TUI에서 `/help`로 확인한다. `/tasks`는 현재 세션이 소유한 background task만
다루며 `/rewind`는 마지막으로 관리된 파일 변경만 현재 상태 확인 후 복원한다.

## 권한과 workspace trust

권한 모드는 편의 수준을 정하지만 hard deny, workspace/path 경계, credential 보호, 입력 schema와 출력
상한을 해제하지 않는다.

| 모드 | 자동 허용 범위 | 그 밖의 동작 |
|---|---|---|
| `ask` | 읽기와 제한된 공개 웹 | 대화형 승인 요청 |
| `auto-edit` | 읽기, 공개 웹, 파일 편집 | shell·외부 작업 등은 승인 요청 |
| `full-auto` | 중앙 정책을 통과한 도구 category | 명시 차단과 신뢰·경로·secret 경계는 계속 적용 |
| `plan` | 읽기와 제한된 공개 웹 | 편집·명령·외부 작업은 노출하지 않음 |

`--disallowed-tools`는 항상 우선한다. `--allowed-tools`는 선택한 비외부 도구의 승인 질문을 줄일 수 있지만
도구를 새로 구현하거나 path/trust 정책을 우회하지 않는다. MCP 같은 external 작업은 server 선언의
`readOnlyHint`만으로 자동 승인되지 않는다.

프로젝트의 `.cat` 설정·명령·skill 또는 `AGENTS.md` 계열 지침이 있으면 filesystem identity 단위의
workspace trust가 필요하다. 대화형 실행은 관련 파일 목록과 신뢰 선택 화면을 열지만, 실제 내용은
사용자가 직접 검토해야 한다. `--print`는 자동으로 신뢰하지 않는다. 비대화형에서
`--trust-workspace`를 쓰면 현재 identity를 신뢰 저장소에 기록한다. 새 managed worktree와 다른 cwd는
별도 identity로 다시 확인한다.

프로젝트 지침, skill, hook 출력, MCP 응답, 웹 페이지와 도구 출력은 모두 데이터로 취급되며 스스로
권한을 부여할 수 없다. public web은 HTTP(S), DNS와 redirect마다 public destination인지 확인하고
응답 크기·시간을 제한하지만, 검색어나 URL에 private 정보가 들어가지 않도록 사용자도 확인해야 한다.

## 내장 도구

기본 registry에는 다음 18개가 연결된다. MCP에서 발견한 동적 도구는 이 수에 포함하지 않는다.

- 읽기: `list_files`, `read_file`, `search_text`
- 편집: `edit_file`, `write_file`, `apply_patch`
- agent 상호작용: `update_plan`, `request_user_input`
- 확장: `load_skill`
- 공개 웹: `web_search`, `fetch_url`
- 명령과 background task: `run_command`, `list_tasks`, `get_task_output`, `stop_task`
- MCP 설정 관리: `list_mcp_servers`, `add_mcp_server`, `remove_mcp_server`

비대화형 실행에서도 `request_user_input` 이름은 registry에 있지만 입력을 요청하지 않고
`user_input_unavailable`로 실패한다. 파일 편집은 workspace 내부의 검증된 경로에만 적용하고,
`apply_patch`는 전체 변경을 먼저 검증한 뒤 실패 시 관리 가능한 범위에서 rollback을 시도한다.

## 설정과 데이터

`CAT_HOME`의 기본값은 `~/.cat`이다. 주요 사용자 데이터는 다음 위치에 둔다.

| 경로 | 내용 |
|---|---|
| `~/.cat/settings.json` | 사용자 설정 |
| `~/.cat/credentials.json` | API key credential; 비밀 파일 |
| `~/.cat/profiles.json` | endpoint와 credential reference가 있는 provider profile |
| `~/.cat/sessions/` | session index, transcript와 writer lock |
| `~/.cat/trusted-workspaces.json` | filesystem identity 기반 trust |
| `~/.cat/project-approvals.json` | workspace별 영구 tool 승인 rule |
| `~/.cat/tasks/` | background task 상태와 bounded output |
| `~/.cat/worktrees/` | managed worktree registry |
| `~/.cat/commands/`, `~/.cat/skills/` | 사용자 markdown command와 skill |

`CAT_HOME`을 바꾸려면 제어 문자가 없는 절대 경로를 사용한다. credential, transcript, trust와 approval
파일은 현재 사용자 전용 권한을 전제로 하며 symlink나 소유권이 안전하지 않으면 읽기 또는 쓰기를
거부할 수 있다. 비밀 파일을 Git에 추가하거나 일반 backup·로그로 복사하지 않는다.

설정 우선순위는 기본값 → 사용자 설정 → 신뢰된 project/local 설정 → `CAT_*` 환경변수 → CLI다.
프로젝트 설정은 Git root의 `.cat/settings.json`, `.cat/settings.local.json`이며 trust 전에는 읽지 않는다.
간단한 사용자 설정 예시는 다음과 같다.

```json
{
  "schemaVersion": 1,
  "permissionMode": "ask",
  "maxTurns": 12,
  "tools": "default",
  "disallowedTools": ["run_command"]
}
```

설정 파일에는 API key, token, password, cookie 같은 secret을 넣을 수 없다. `CAT_PROVIDER`,
`CAT_PROFILE`, `CAT_MODEL`, `CAT_PERMISSION_MODE`, `CAT_TOOLS`, `CAT_MAX_TURNS`, `CAT_VERBOSE`로 일부
설정을 덮어쓸 수 있다.

세션은 append-only JSONL metadata와 transcript로 저장한다. `--no-session-persistence`는 현재 실행의
새 세션 기록을 만들지 않는다. 실행 중에는 도구 시작 전과 결과 수신 후에 메시지·이벤트를 순차 저장한다.
저장 실패 시 추가 실행을 차단하며, 재개할 때 결과가 누락된 호출은 성공이나 미실행으로 추측하지 않고
`unknown`으로 표시한다. 이미 발생한 셸·MCP 부작용은 실제 상태를 확인하기 전 자동 재실행하지 않는다.
transcript 출력과 저장은 알려진 secret과 민감 field를 가리지만,
임의의 비밀 문자열을 모두 탐지한다고 보장하지 않으므로 prompt와 tool 출력에 secret을 넣지 않는 것이
안전하다.

## 기존 Smile Code 데이터 이관

이관은 자동 실행되지 않는다. 기본 원본은 `~/.smileserv`이며 다음 명령만 새 `CAT_HOME`으로 복사한다.

```bash
# 설정과 세션만 가져오며 credential 파일 내용은 읽지 않음
cat-tui migrate

# source를 명시하고 plaintext API key profile 읽기·이관에도 별도 동의
cat-tui migrate --source /absolute/path/to/.smileserv --include-credentials
```

원본과 `CAT_HOME`이 같거나 서로 포함하면 중단한다. 대상 설정이나 같은 이름의 profile, 이미 생성된
`legacy_*` session ID가 있으면 덮어쓰지 않고 건너뛴다. `permissionMode`, `allowedTools`, trust,
project approval, hook과 MCP 실행 설정은 자동 이관하지 않는다. source는 수정·권한 변경·삭제하지 않으며
실제 provider key 확인 요청도 보내지 않는다.

`tools`와 기존 `deniedTools` 값은 현재 내장 도구 18개의 정확한 이름만 남긴다. 함께 가져오지 않는 MCP
설정에 속한 동적 도구나 알 수 없는 도구 이름은 새 설정에서 제외한다. credential 이관을 선택하면 API
key 후보를 오류 출력 redaction에 먼저 등록하고, 새 provider catalog와 공개 profile·설정 field 분리
규칙을 통과한 HTTPS profile만 저장한다.

원본 디렉터리와 credential/session 자료는 현재 사용자 소유와 private mode를 만족해야 한다. 손상되거나
상한을 넘는 transcript record는 원본에 남기고 결과에 경고·생략 수를 표시한다. 가져온 세션은 closed
상태이며 원본 ID 대신 충돌을 피하는 결정적 `legacy_*` ID를 쓴다.

## 알려진 제한과 안전한 기대치

- 로컬 모의 API와 실제 PTY에서 초기 설정, 진행 표시·승인·거부·취소, 긴 권한 창·resize,
  오류 복귀, 대화 이름·재개, 원문 보기·무색상 표시를 확인했다. 이 검증은 실제 외부 서비스 성공,
  모든 terminal의 호환성,
  공격 내성 또는 전체 기능 검증 완료를 뜻하지 않는다.
- 전체 시간 제한 제거는 가상 시계로 확인했으며 실제 장시간 서버 운용 시험은 아니다.
  v0.1.4 새 설치본은 별도로 실행하지 않았다.
- 실제 provider API, model 목록·streaming 차이와 과금은 확인하지 않았다. catalog endpoint는 호환을 위한
  초기값이며 provider의 현재 제공 상태를 보증하지 않는다.
- MCP는 stdio transport와 두 protocol adapter만 구현한다. 설정 저장 성공은 server 실행·schema 호환·
  도구 성공을 뜻하지 않는다.
- 공개 웹 검색 backend와 HTML parsing은 외부 서비스 변화에 영향을 받을 수 있으며 실제 검색·fetch를
  검증하지 않았다. 결과 본문은 신뢰되지 않은 자료다.
- `/rewind`는 현재 process가 관리하고 이후 변경되지 않은 파일 checkpoint만 복원한다. shell, network,
  MCP, background process 부작용이나 임의의 사용자 변경을 되돌리지 않는다.
- background task 종료 요청과 SSH 종료는 cleanup 확인에 실패할 수 있다. 확인되지 않은 process를 성공
  종료로 표시하지 않으므로 사용자가 OS 상태를 점검해야 할 수 있다.
- local clipboard backend나 OSC52 지원 여부는 OS·terminal·SSH 환경에 따라 다르며 실제 환경에서
  검증하지 않았다. clipboard 읽기는 지원하지 않는다.
- Linux arm64, root 설치, 설치 실패 시 rollback은 실행 검증하지 않았다. 로컬 artifact 생성과
  GitHub Release 게시는 별도이며, 사용자 서버의 운영 호환성도 별도 확인이 필요하다.
- package는 `UNLICENSED`이며 공개 사용·재배포 조건이 부여됐다고 해석하면 안 된다.

## 자주 만나는 오류

- `사용 가능한 API key profile이 없습니다`: 대화형 TTY에서 `cat-tui auth setup`을 먼저 실행한다.
- `프로젝트 사용자 설정이 있습니다`: 관련 `.cat` 파일과 `AGENTS.md` 계열을 검토한 뒤 대화형 trust
  화면을 사용하거나, 비대화형이면 의도적으로 `--trust-workspace`를 지정한다.
- `비대화형 실행에서는 승인이 필요한 작업을 실행하지 않습니다`: TUI에서 범위를 승인하거나,
  자동화 목적에 맞는 권한 모드·도구 allow/deny를 최소 범위로 지정한다.
- 저장소 소유권·private mode 오류: 경로가 현재 사용자 소유인지, symlink가 아닌지, credential과 session
  파일이 다른 사용자에게 열려 있지 않은지 확인한다. cat은 원본 legacy 권한을 자동 변경하지 않는다.
- `CAT_HOME`과 legacy source 중첩 오류: 서로 포함하지 않는 별도 절대 디렉터리를 사용한다.

구현과 단계별 검증 근거는 `docs/implementation/`에 기록한다.
