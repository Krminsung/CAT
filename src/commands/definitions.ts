export const SLASH_COMMAND_CAPABILITIES = [
  "terminal",
  "session",
  "authentication",
  "model",
  "permission",
  "configuration",
  "compaction",
  "git",
  "extensions",
  "mcp",
  "tasks",
  "worktree",
] as const;

export type SlashCommandCapability = (typeof SLASH_COMMAND_CAPABILITIES)[number];

export const SLASH_COMMAND_NAMES = [
  "help",
  "new",
  "clear",
  "compact",
  "config",
  "cost",
  "details",
  "diff",
  "exit",
  "fork",
  "init",
  "memory",
  "mcp",
  "connect",
  "disconnect",
  "model",
  "models",
  "provider",
  "permissions",
  "raw",
  "rename",
  "reload",
  "resume",
  "sessions",
  "rewind",
  "status",
  "tasks",
  "worktree",
] as const;

export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

export interface SlashCommandDefinition {
  readonly name: SlashCommandName;
  readonly description: string;
  readonly usage: string;
  readonly capability: SlashCommandCapability;
  readonly unavailableReason: string;
}

const RAW_DEFINITIONS: readonly SlashCommandDefinition[] = [
  { name: "help", description: "사용 가능한 명령과 단축키 표시", usage: "/help", capability: "terminal", unavailableReason: "대화형 명령 UI가 연결되지 않았습니다." },
  { name: "new", description: "현재 설정으로 새 세션 시작", usage: "/new [name]", capability: "session", unavailableReason: "세션 lifecycle이 연결되지 않았습니다." },
  { name: "clear", description: "저장 기록은 유지하고 현재 화면만 정리", usage: "/clear", capability: "terminal", unavailableReason: "대화 화면이 연결되지 않았습니다." },
  { name: "compact", description: "현재 대화를 제한된 요약으로 압축", usage: "/compact", capability: "compaction", unavailableReason: "공유 run 예산을 사용하는 compaction 경로가 연결되지 않았습니다." },
  { name: "config", description: "병합된 설정과 설정 출처 표시", usage: "/config", capability: "configuration", unavailableReason: "설정 표시 경로가 연결되지 않았습니다." },
  { name: "cost", description: "알려진 token 사용량 표시", usage: "/cost", capability: "configuration", unavailableReason: "사용량 집계가 연결되지 않았습니다." },
  { name: "details", description: "도구·계획 상세 표시 전환", usage: "/details", capability: "terminal", unavailableReason: "대화 상세 화면이 연결되지 않았습니다." },
  { name: "diff", description: "중앙 권한 경계로 작업 변경 표시", usage: "/diff", capability: "git", unavailableReason: "Git 변경 조회 경로가 연결되지 않았습니다." },
  { name: "exit", description: "현재 세션을 닫고 cat 종료", usage: "/exit", capability: "terminal", unavailableReason: "대화 화면 종료 경로가 연결되지 않았습니다." },
  { name: "fork", description: "현재 대화를 새 ID의 세션으로 분기", usage: "/fork [name]", capability: "session", unavailableReason: "세션 분기 기능이 연결되지 않았습니다." },
  { name: "init", description: "기존 파일을 덮지 않고 AGENTS 지침 초기화", usage: "/init", capability: "extensions", unavailableReason: "프로젝트 지침 초기화 경로가 연결되지 않았습니다." },
  { name: "memory", description: "현재 로드된 프로젝트 지침 표시", usage: "/memory", capability: "extensions", unavailableReason: "프로젝트 지침 조회 경로가 연결되지 않았습니다." },
  { name: "mcp", description: "MCP 서버와 도구 상태 확인 또는 승인 후 재연결", usage: "/mcp [reconnect]", capability: "mcp", unavailableReason: "MCP manager가 연결되지 않았습니다." },
  { name: "connect", description: "masked 입력으로 API key profile 연결", usage: "/connect [provider] [profile]", capability: "authentication", unavailableReason: "인증 overlay가 연결되지 않았습니다." },
  { name: "disconnect", description: "지정 API key profile 제거", usage: "/disconnect [profile]", capability: "authentication", unavailableReason: "인증 관리 경로가 연결되지 않았습니다." },
  { name: "model", description: "model ID 확인 또는 선택", usage: "/model [model-id]", capability: "model", unavailableReason: "model 선택 경로가 연결되지 않았습니다." },
  { name: "models", description: "현재 provider의 model 목록에서 선택", usage: "/models", capability: "model", unavailableReason: "model 목록 선택 경로가 연결되지 않았습니다." },
  { name: "provider", description: "저장된 provider profile 선택", usage: "/provider [profile]", capability: "authentication", unavailableReason: "provider profile 선택 경로가 연결되지 않았습니다." },
  { name: "permissions", description: "권한 모드 확인 또는 변경", usage: "/permissions [ask|auto-edit|full-auto|plan]", capability: "permission", unavailableReason: "권한 선택 경로가 연결되지 않았습니다." },
  { name: "raw", description: "제한된 복사 보기 또는 명시적 clipboard 복사", usage: "/raw [copy]", capability: "terminal", unavailableReason: "raw transcript 화면이 연결되지 않았습니다." },
  { name: "rename", description: "현재 세션 표시 이름 변경", usage: "/rename <name>", capability: "session", unavailableReason: "세션 이름 변경 경로가 연결되지 않았습니다." },
  { name: "reload", description: "신뢰한 지침·명령·skill·hook 다시 로드", usage: "/reload", capability: "extensions", unavailableReason: "확장 재로딩 경로가 연결되지 않았습니다." },
  { name: "resume", description: "저장된 현재 workspace 세션 재개", usage: "/resume [session-id]", capability: "session", unavailableReason: "세션 재개 선택 경로가 연결되지 않았습니다." },
  { name: "sessions", description: "저장된 현재 workspace 세션 목록 표시", usage: "/sessions", capability: "session", unavailableReason: "세션 선택 경로가 연결되지 않았습니다." },
  { name: "rewind", description: "현재 세션의 마지막 관리 파일 변경 복원", usage: "/rewind", capability: "session", unavailableReason: "checkpoint rewind 경로가 연결되지 않았습니다." },
  { name: "status", description: "세션·provider·model·workspace 상태 표시", usage: "/status", capability: "configuration", unavailableReason: "상태 표시 경로가 연결되지 않았습니다." },
  { name: "tasks", description: "현재 세션 소유 background 작업 관리", usage: "/tasks [task-id|stop task-id]", capability: "tasks", unavailableReason: "background task manager가 연결되지 않았습니다." },
  { name: "worktree", description: "관리되는 격리 worktree 정보 표시", usage: "/worktree", capability: "worktree", unavailableReason: "managed worktree 정보가 연결되지 않았습니다." },
];

function stableDefinitions(): readonly SlashCommandDefinition[] {
  if (RAW_DEFINITIONS.length !== SLASH_COMMAND_NAMES.length || RAW_DEFINITIONS.length !== 28) {
    throw new Error("기본 slash 명령 정의는 정확히 28개여야 합니다.");
  }
  const expected = new Set<string>(SLASH_COMMAND_NAMES);
  const seen = new Set<string>();
  const capabilities = new Set<string>(SLASH_COMMAND_CAPABILITIES);
  const output: SlashCommandDefinition[] = [];
  for (const definition of RAW_DEFINITIONS) {
    if (
      !expected.has(definition.name) ||
      seen.has(definition.name) ||
      !capabilities.has(definition.capability) ||
      !definition.description.trim() ||
      definition.description.length > 512 ||
      (definition.usage !== `/${definition.name}` &&
        !definition.usage.startsWith(`/${definition.name} `)) ||
      !definition.unavailableReason.trim()
    ) {
      throw new Error(`기본 slash 명령 정의가 올바르지 않습니다: ${definition.name}`);
    }
    seen.add(definition.name);
    output.push(Object.freeze({ ...definition }));
  }
  for (const name of expected) {
    if (!seen.has(name)) throw new Error(`기본 slash 명령 정의가 없습니다: ${name}`);
  }
  return Object.freeze(output);
}

export const SLASH_COMMAND_DEFINITIONS = stableDefinitions();

export function isSlashCommandName(value: string): value is SlashCommandName {
  return (SLASH_COMMAND_NAMES as readonly string[]).includes(value);
}
