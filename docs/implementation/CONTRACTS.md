# 기능 계약 대응표

이 문서는 Smile Code 0.14.6에서 보존할 관찰 가능한 계약과 cat의 실제 구현·연결 경계를 기록한다.
`IMPLEMENTED`는 source와 제품 entrypoint의 정적 연결을 확인했다는 뜻이며 runtime 실행 검증을 뜻하지
않는다. 동적 MCP 도구는 built-in 수에 포함하지 않는다.

| 계약 | 원본 근거 | cat 구현 경계 | 단계 | 상태 |
|---|---|---|---|---|
| 제품명·`cat-tui` 실행 정책 | `package.json`, `src/version.ts` | `package.json`, `src/core/version.ts`, `bin/cat` | P01/P14 | IN_PROGRESS |
| provider 중립 JSON/message/tool/event | `src/types.ts` | `src/core/*` | P01 | IMPLEMENTED |
| 설정·API key·profile·trust | `src/settings.ts`, `src/auth.ts`, `src/trust.ts` | `src/storage/*`, `src/security/*` | P02 | IMPLEMENTED |
| 13개 provider와 SSE transport | `src/providers.ts`, `src/api.ts`, `src/http.ts` | `src/providers/*`, `src/transport/*` | P03 | IMPLEMENTED |
| 권한과 기본 파일·foreground shell 도구 | `src/tools.ts`, `src/permissions.ts` | `src/security/*`, `src/tools/*` | P04 | IMPLEMENTED |
| 단일 소유 bounded agent loop | `src/agent.ts` | `src/agent/*` | P05 | IMPLEMENTED |
| JSONL 세션·컨텍스트·rewind | `src/sessions.ts`, `src/history.ts`, `src/checkpoints.ts` | `src/storage/*`, `src/context/*` | P06 | IMPLEMENTED |
| pi-tui 화면과 입력 | `src/tui.ts` | `src/tui/*`, `src/app/terminal-ui.ts` | P07 | IMPLEMENTED |
| CLI와 28개 slash 명령 | `src/cli.ts` | `src/cli/*`, `src/commands/*`, `src/app/application.ts` | P08/P13 | IMPLEMENTED |
| AGENTS·skills·markdown commands·8 hooks | `src/context.ts`, `src/extensions.ts`, `src/hooks.ts` | `src/extensions/*`, `src/app/application.ts` | P09/P13 | IMPLEMENTED |
| stdio MCP 2개 protocol | `src/mcp.ts` | `src/mcp/*` | P10/P13 | IMPLEMENTED |
| public web 검색·fetch·evidence | `src/tools.ts`, `src/agent.ts` | `src/web/*` | P11 | IMPLEMENTED |
| background tasks·worktree·SSH/clipboard | `src/tasks.ts`, `src/worktree.ts`, `src/clipboard.ts`, `src/ssh-clipboard.ts` | `src/process/*`, `src/git/*`, `src/clipboard/*` | P12 | IMPLEMENTED |
| 기존 데이터의 명시적 비파괴 이관 | `src/sessions.ts`, `src/auth.ts` | `src/storage/legacy.ts`, `src/app/legacy-import.ts`, `src/cli/legacy.ts` | P13 | IMPLEMENTED |
| npm 없는 사용자 영역 설치본 | `scripts/*`, `smilecode` | `scripts/*`, `bin/cat` | P14 | PLANNED |

## P13.1 최종 기능 매트릭스

### built-in 도구 18개

`src/tools/runtime.ts`의 `BUILTIN_TOOL_NAMES`가 순서와 이름의 기준이다. 제품 조립은 모든 등록이 끝난
직후 실제 registry 순서를 이 상수와 대조하며 하나라도 없거나 추가되면 fail closed한다.

| 구현 경계 | 등록 도구 |
|---|---|
| `src/tools/read-tools.ts` | `list_files`, `read_file`, `search_text` |
| `src/tools/mutation-tools.ts` | `edit_file`, `write_file`, `apply_patch` |
| `src/agent/interactive.ts` | `update_plan`, `request_user_input` |
| `src/extensions/skill-tool.ts` | `load_skill` |
| `src/web/tools.ts` | `web_search`, `fetch_url` |
| `src/tools/command-tool.ts` | `run_command`, `list_tasks`, `get_task_output`, `stop_task` |
| `src/mcp/tools.ts` | `list_mcp_servers`, `add_mcp_server`, `remove_mcp_server` |

`request_user_input`은 대화형·비대화형 모두 registry에 존재한다. 비대화형에서는 입력 port를 호출하지
않고 `user_input_unavailable`/`not_started` 실패를 반환하므로 미지원 상태를 성공이나 도구 부재로
가장하지 않는다. 모든 도구 호출은 `CentralToolExecutor`의 schema, permission, hook, redaction,
output 상한을 통과한다.

### slash 명령 28개

`src/commands/definitions.ts`의 `SLASH_COMMAND_NAMES`와 고정 정의가 정확히 28개인지 module 경계에서
확인한다. `src/app/application.ts`의 `#createCommands`에는 아래 28개 handler와 필요한 12개 capability가
모두 연결되며, 조립 시 실제 active definition을 기준 목록과 다시 대조한다.

`help`, `new`, `clear`, `compact`, `config`, `cost`, `details`, `diff`, `exit`, `fork`, `init`,
`memory`, `mcp`, `connect`, `disconnect`, `model`, `models`, `provider`, `permissions`, `raw`,
`rename`, `reload`, `resume`, `sessions`, `rewind`, `status`, `tasks`, `worktree`.

### provider 13개

`src/storage/profiles.ts`의 `PROVIDER_IDS`와 `src/providers/catalog.ts`의 exhaustive mapped catalog가
다음 13개를 같은 ID로 연결한다.

`internal`, `openai`, `anthropic`, `google`, `openrouter`, `xai`, `groq`, `deepseek`, `mistral`,
`together`, `cerebras`, `fireworks`, `custom`.

기본 endpoint는 catalog 값에 묶이고 `custom`만 사용자 endpoint를 요구한다. API key는 profile에
직접 넣지 않고 origin-bound credential reference로 연결한다.

### CLI 옵션과 관리 진입점

`src/cli/args.ts`가 다음 agent 옵션을 bounded parser로 해석하고 `src/cli/run.ts`가 help/version,
management, agent 진입점을 분리한다.

`-h/--help`, `-p/--print`, `-C/--cwd`, `--provider`, `--profile`, `--model`, `--base-url`,
`--max-turns`, `--permission-mode`와 `--approval-mode` 별칭, `-c/--continue`, `-r/--resume`,
`-n/--name`, `--output-format`, `--tools`, `--allowed-tools`, `--disallowed-tools`,
`--append-system-prompt`, `--no-session-persistence`, `--verbose`, `--no-color`,
`--trust-workspace`, `-w/--worktree`, `--version`, positional prompt.

`CLI_MANAGEMENT_COMMANDS`가 관리 진입점 `auth`, `mcp`, `worktree`, `ssh`, `migrate`의 단일 기준이며
parser type과 dispatch 입력이 이 tuple에서 파생된다. `src/app/application.ts`가 각 controller,
legacy import service 또는 agent lifecycle로 실제 dispatch한다.

### hook event 8개

`src/extensions/hooks.ts`의 `HOOK_EVENTS`는 `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `SessionEnd`의 정확히 8개다.
session/prompt/compaction/end는 `src/app/application.ts`, tool 전후는 `HookToolPort`, stop은
`HookStopPort`를 통해 연결된다. block 가능한 event와 exit code 의미, 입력·출력·시간 상한은 모두
`HookEngine` 한 경계에서 적용된다.

### MCP protocol 2개

`src/mcp/protocol.ts`의 `MCP_PROTOCOL_VERSIONS`는 `2025-11-25`, `2026-07-28` 두 개다.
`createMcpProtocolAdapter`가 legacy initialize/initialized 흐름과 modern request metadata 흐름을
각각 `LegacyMcpProtocolAdapter`, `ModernMcpProtocolAdapter`로 분기한다. config, CLI, 관리 도구도
같은 상수를 사용한다.

## P13.2 legacy import 계약

`cat-tui migrate [--source DIRECTORY] [--include-credentials]`만 이관을 시작한다. 기본 source는
`~/.smileserv`이며 source와 `CAT_HOME`이 같거나 서로 포함하면 중단한다. source 디렉터리 identity,
현재 사용자 소유권·private mode, 파일·디렉터리의 non-symlink/일반 형식, credential·session 자료의
private mode와 읽는 동안 identity·크기 변경을 확인한다. 원본 경로에는 write, rename, chmod, unlink를
수행하지 않는다.

- 사용자 설정은 대상 `~/.cat/settings.json`이 없을 때만 새로 쓴다. model, budget, context,
  verbose, 도구 선택, 문서 크기·fallback과 더 제한적인 `deniedTools→disallowedTools`만 변환한다.
  `permissionMode`, `allowedTools`, 기존 승인, hooks, MCP 실행 설정과 알 수 없는 key는 자동 이관하지
  않는다.
- `providers.json`과 `credentials.json`의 내용은 `--include-credentials`가 있을 때만 읽는다. 모든
  profile·API key·HTTPS endpoint·protocol·크기를 먼저 검증하고, 대상과 같은 profile 이름은 덮어쓰지
  않고 건너뛴다. 새 credential 저장 뒤 profile 저장이 실패하면 그 호출에서 만든 credential만
  정리한다. 외부 API 확인 요청은 하지 않는다.
- 세션 index는 page/record/전체 byte 상한 안에서 두 legacy field 표기를 읽고 최신 record를 선택한다.
  target ID는 source identity와 원본 ID의 hash로 만든 `legacy_*` ID라 기존 ID를 덮어쓰지 않으며,
  target index나 transcript 경로가 이미 있으면 건너뛴다. 가져온 session은 closed 상태로 기록한다.
- 실제 model history에 전달됐던 user/assistant transcript만 새 message schema로 변환한다. 숨김·미전달
  record와 도구 사용 중간 assistant 응답을 포함한 나머지는 실행되지 않는 `legacy_record` agent event로
  보존한다. line·session·전체 byte/record 상한과 secret redaction을 적용하며 손상·초과 record는 원본을
  유지한 채 집계해 알린다.
- `trusted-workspaces.json`, project approval과 자동 허용 상태는 읽어 새 trust/approval로 만들지 않는다.
  실행 결과는 이 두 항목이 이관되지 않았고 원본이 변경되지 않았음을 명시한다.

## P13.4 통합 범위 정리

제품 source의 제품명·단계 문구, secret 형태 fixture, stub·registry·cleanup을 기능 계약과 P13 diff
중심으로 한 차례 검색했다. 관리 명령 이름은 `CLI_MANAGEMENT_COMMANDS`로 단일화했고, built-in/slash,
provider, hook, MCP protocol은 기존 기준 상수와 조립 시 exact 대조를 유지한다. 모든 slash handler가
연결된 현재 제품에서 fallback 문구가 과거 P09를 안내하지 않도록 capability 미연결 문구로 바꿨다.

새 제품을 Smile Code로 표시하는 경로와 secret fixture는 발견되지 않았다. 남아 있는 Smile Code 이름,
`.smileserv`, 기존 환경변수·provider alias·지침 파일명은 P13.2 이관, 민감 경로 차단과 출처 보존에
필요한 legacy 호환 표식이라 삭제하지 않았다. P13 변경의 writer와 credential 실패 정리 경로를 다시
확인했으며 실행되지 않는 성공 handler나 새 누락 cleanup은 발견되지 않았다.

## 검증 한계

이 매트릭스는 source 상수, registry, handler, entrypoint를 한 차례 정적으로 대조한 결과다. P13의
허용된 `npm run check`는 아직 실행하지 않았으며 앱, TUI, provider, hook, MCP, 외부 명령 runtime을
실행해 검증하지 않았다.
