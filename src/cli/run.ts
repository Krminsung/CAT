import {
  CancelledError,
  CatError,
  ConfigurationError,
} from "../core/errors.js";
import { VERSION } from "../core/version.js";
import {
  CliUsageError,
  cliHelp,
  cliUsage,
  parseCliInvocation,
  type CliManagementCommand,
  type CliOptions,
} from "./args.js";
import { CliOutput, type CliWritable } from "./output.js";

export interface CliApplication {
  runAgent(options: CliOptions, output: CliOutput): Promise<number>;
  runManagement(
    command: CliManagementCommand,
    args: readonly string[],
    output: CliOutput,
  ): Promise<number>;
}

export interface RunCliOptions {
  readonly application?: CliApplication;
  readonly stdout?: CliWritable;
  readonly stderr?: CliWritable;
}

const UNAVAILABLE_APPLICATION: CliApplication = Object.freeze({
  runAgent: async (): Promise<number> => {
    throw new ConfigurationError("CLI 앱 lifecycle이 아직 연결되지 않았습니다.");
  },
  runManagement: async (command: CliManagementCommand): Promise<number> => {
    throw new ConfigurationError(`${command} 관리 명령은 아직 연결되지 않았습니다.`);
  },
});

function validExitCode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let output = new CliOutput({ format: "text", stdout, stderr });
  try {
    const invocation = parseCliInvocation(argv);
    if (invocation.kind === "help") {
      output.writeTrustedText(cliHelp());
      return 0;
    }
    if (invocation.kind === "version") {
      output.writeTrustedText(`${VERSION}\n`);
      return 0;
    }
    const application = options.application ?? UNAVAILABLE_APPLICATION;
    if (invocation.kind === "management") {
      return validExitCode(await application.runManagement(
        invocation.command,
        invocation.args,
        output,
      ));
    }
    output = new CliOutput({
      format: invocation.options.outputFormat,
      stdout,
      stderr,
    });
    return validExitCode(await application.runAgent(invocation.options, output));
  } catch (error) {
    if (error instanceof CliUsageError) {
      output.diagnostic(`${cliUsage()}\ncat-tui: ${error.message}`);
      return 2;
    }
    if (error instanceof CancelledError) {
      output.diagnostic(`cat: ${error.message}`);
      return 130;
    }
    if (error instanceof CatError || error instanceof ConfigurationError) {
      output.diagnostic(`cat: ${error.message}`);
      return 1;
    }
    output.diagnostic("cat: 처리하지 못한 오류로 실행을 종료했습니다.");
    return 1;
  }
}
