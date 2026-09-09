# 기능 계약 대응표

이 표는 Smile Code 0.14.6의 관찰 가능한 계약을 새 구조에서 어디에 구현할지
기록한다. `PLANNED`는 아직 제품 registry에 노출하지 않는다는 뜻이다.

| 계약 | 원본 근거 | cat 구현 경계 | 단계 | 상태 |
|---|---|---|---|---|
| 제품명·`cat-tui` 실행 정책 | `package.json`, `src/version.ts` | `package.json`, `src/core/version.ts`, `bin/cat` | P01/P14 | IN_PROGRESS |
| provider 중립 JSON/message/tool/event | `src/types.ts` | `src/core/*` | P01 | IMPLEMENTED |
| 설정·API key·profile·trust | `src/settings.ts`, `src/auth.ts`, `src/trust.ts` | `src/storage/*`, `src/security/*` | P02 | PLANNED |
| 13개 provider와 SSE transport | `src/providers.ts`, `src/api.ts`, `src/http.ts` | `src/providers/*`, `src/transport/*` | P03 | PLANNED |
| 권한과 기본 파일·foreground shell 도구 | `src/tools.ts`, `src/permissions.ts` | `src/security/*`, `src/tools/*` | P04 | PLANNED |
| 단일 소유 bounded agent loop | `src/agent.ts` | `src/agent/*` | P05 | PLANNED |
| JSONL 세션·컨텍스트·rewind | `src/sessions.ts`, `src/history.ts`, `src/checkpoints.ts` | `src/storage/*`, `src/context/*` | P06 | PLANNED |
| pi-tui 화면과 입력 | `src/tui.ts` | `src/tui/*` | P07 | PLANNED |
| CLI와 28개 slash 명령 | `src/cli.ts` | `src/cli/*`, `src/tui/commands/*` | P08 | PLANNED |
| AGENTS·skills·markdown commands·8 hooks | `src/context.ts`, `src/extensions.ts`, `src/hooks.ts` | `src/context/*`, `src/extensions/*` | P09 | PLANNED |
| stdio MCP 2개 protocol | `src/mcp.ts` | `src/mcp/*` | P10 | PLANNED |
| public web 검색·fetch·evidence | `src/tools.ts`, `src/agent.ts` | `src/web/*` | P11 | PLANNED |
| background tasks·worktree·SSH/clipboard | `src/tasks.ts`, `src/worktree.ts`, `src/clipboard.ts`, `src/ssh-clipboard.ts` | `src/process/*`, `src/git/*`, `src/clipboard/*` | P12 | PLANNED |
| 기존 데이터의 명시적 비파괴 이관 | `src/sessions.ts`, `src/auth.ts` | `src/storage/legacy/*` | P13 | PLANNED |
| npm 없는 사용자 영역 설치본 | `scripts/*`, `smilecode` | `scripts/*`, `bin/cat` | P14 | PLANNED |

최종 정적 대조 수치는 built-in 도구 18개, slash 명령 28개, provider 13개,
hook event 8개, MCP protocol 2개다. 동적 MCP 도구는 built-in 수에 포함하지 않는다.
