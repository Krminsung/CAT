import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LegacyImportService } from "../app/legacy-import.js";
import { CliUsageError } from "./args.js";
import type { CliOutput } from "./output.js";

const MAX_MIGRATION_ARGUMENTS = 16;
const MAX_MIGRATION_ARGUMENT_BYTES = 16 * 1024;

export interface LegacyMigrationControllerOptions {
  readonly service: LegacyImportService;
  readonly defaultSourceRoot?: string;
}

export function legacyMigrationHelp(): string {
  return "usage: cat-tui migrate [--source DIRECTORY] [--include-credentials]\n\n" +
    "기존 Smile Code 사용자 데이터를 원본을 바꾸지 않고 CAT_HOME(기본 ~/.cat)으로 가져옵니다.\n\n" +
    "options:\n" +
    "  --source DIRECTORY        기존 데이터 루트(기본: ~/.smileserv)\n" +
    "  --include-credentials     plaintext API key 파일 읽기와 profile 이관에 별도 동의\n\n" +
    "기존 trust와 승인, allowedTools, hooks, MCP 실행 설정은 자동으로 가져오지 않습니다.\n";
}

function parseArguments(
  args: readonly string[],
  defaultSourceRoot: string,
): { readonly sourceRoot: string; readonly includeCredentials: boolean } {
  if (args.length > MAX_MIGRATION_ARGUMENTS) {
    throw new CliUsageError(`migrate 인자는 최대 ${MAX_MIGRATION_ARGUMENTS}개까지 사용할 수 있습니다.`);
  }
  let bytes = 0;
  let sourceRoot = defaultSourceRoot;
  let sourceSeen = false;
  let includeCredentials = false;
  for (let index = 0; index < args.length; index += 1) {
    let argument = args[index] ?? "";
    bytes += Buffer.byteLength(argument, "utf8") + 1;
    if (
      argument.includes("\0") ||
      bytes > MAX_MIGRATION_ARGUMENT_BYTES
    ) {
      throw new CliUsageError("migrate 인자의 형식 또는 전체 크기가 올바르지 않습니다.");
    }
    if (argument === "--include-credentials") {
      if (includeCredentials) {
        throw new CliUsageError("--include-credentials를 중복 지정할 수 없습니다.");
      }
      includeCredentials = true;
      continue;
    }
    let inlineValue: string | undefined;
    const assignment = argument.match(/^(--source)=(.*)$/su);
    if (assignment) {
      argument = assignment[1] ?? "";
      inlineValue = assignment[2] ?? "";
    }
    if (argument !== "--source") {
      throw new CliUsageError(`migrate의 알 수 없는 인자입니다: ${argument || "(빈 인자)"}`);
    }
    if (sourceSeen) throw new CliUsageError("--source를 중복 지정할 수 없습니다.");
    sourceSeen = true;
    let value = inlineValue;
    if (value === undefined) {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        throw new CliUsageError("--source에 절대 디렉터리 경로가 필요합니다.");
      }
      value = candidate;
      index += 1;
      bytes += Buffer.byteLength(value, "utf8") + 1;
    }
    const selected = value.trim();
    if (
      !isAbsolute(selected) ||
      selected.includes("\0") ||
      /[\u0001-\u001f\u007f]/u.test(selected) ||
      Buffer.byteLength(selected, "utf8") > 4_096 ||
      bytes > MAX_MIGRATION_ARGUMENT_BYTES
    ) {
      throw new CliUsageError("--source는 제어 문자가 없는 4096 bytes 이내 절대 경로여야 합니다.");
    }
    sourceRoot = resolve(selected);
  }
  return Object.freeze({ sourceRoot, includeCredentials });
}

function settingsText(status: string, keys: readonly string[], omitted: number): string {
  const detail = status === "absent"
    ? "원본 파일 없음"
    : status === "target_exists"
      ? "대상 settings.json이 있어 건너뜀"
      : status === "no_supported_values"
        ? "가져올 안전한 호환 값 없음"
        : `가져옴 (${keys.join(", ") || "값 없음"})`;
  return `설정: ${detail}${omitted > 0 ? ` · 자동 이관 제외 ${omitted}개 key` : ""}`;
}

export class LegacyMigrationController {
  readonly #service: LegacyImportService;
  readonly #defaultSourceRoot: string;

  constructor(options: LegacyMigrationControllerOptions) {
    this.#service = options.service;
    this.#defaultSourceRoot = resolve(
      options.defaultSourceRoot ?? join(homedir(), ".smileserv"),
    );
  }

  async run(args: readonly string[], output: CliOutput): Promise<number> {
    if (args.includes("-h") || args.includes("--help")) {
      if (args.length !== 1) {
        throw new CliUsageError("migrate 도움말 옵션은 단독으로 사용해야 합니다.");
      }
      output.writeTrustedText(legacyMigrationHelp());
      return 0;
    }
    const parsed = parseArguments(args, this.#defaultSourceRoot);
    const result = await this.#service.run({
      sourceRoot: parsed.sourceRoot,
      includeCredentials: parsed.includeCredentials,
      onSecrets: (secrets) => output.addKnownSecrets(secrets),
    });
    const credentialText = result.credentials.requested
      ? `credential profile: 발견 ${result.credentials.discovered} · 가져옴 ` +
        `${result.credentials.imported} · 이름 충돌로 건너뜀 ${result.credentials.conflicts}`
      : "credential profile: 읽지 않음 (--include-credentials 별도 동의 필요)";
    const mappingRows = result.sessions.mappings.map(
      (mapping) => `  ${mapping.sourceSessionId} → ${mapping.targetSessionId}`,
    );
    if (result.sessions.omittedMappings > 0) {
      mappingRows.push(`  … ${result.sessions.omittedMappings}개 ID 매핑 생략`);
    }
    output.writeText([
      "기존 Smile Code 데이터 가져오기를 마쳤습니다.",
      `원본: ${result.sourceRoot}`,
      settingsText(
        result.settings.status,
        result.settings.importedKeys,
        result.settings.omittedKeys,
      ),
      credentialText,
      `세션: 발견 ${result.sessions.discovered} · 가져옴 ${result.sessions.imported} · ` +
        `대상 충돌로 건너뜀 ${result.sessions.conflicts}`,
      `세션 index: 형식 불일치 ${result.sessions.invalidIndexRecords} · ` +
        `읽기 경고 ${result.sessions.sourceWarnings}`,
      `transcript: 가져온 record ${result.sessions.transcriptRecords} · ` +
        `경고 ${result.sessions.transcriptWarnings} · 생략 ${result.sessions.omittedTranscriptRecords}`,
      ...(mappingRows.length === 0 ? [] : ["세션 ID 매핑:", ...mappingRows]),
      "trust와 기존 승인은 가져오지 않았습니다.",
      "원본 파일은 변경하거나 삭제하지 않았습니다.",
    ].join("\n"));
    return 0;
  }
}
