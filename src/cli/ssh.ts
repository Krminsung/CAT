import { runSshClipboardBridge } from "../clipboard/ssh-bridge.js";
import type { CliOutput } from "./output.js";

export interface SshManagementControllerOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export function sshHelp(): string {
  return "usage: cat-tui ssh [OpenSSH options] user@host [remote command]\n\n" +
    "접속하는 PC의 대화형 터미널에서 bounded OSC52 clipboard bridge를 엽니다.\n" +
    "SSH 인증, host key 확인과 옵션 의미는 시스템 OpenSSH가 처리합니다.\n" +
    "원격 OSC52 쓰기는 크기·횟수를 제한해 PC clipboard로 전달하지만 읽기 요청은 차단합니다.\n" +
    "원격 OSC/DCS/APC 문자열은 터미널에 그대로 전달하지 않으며 옵션·key 경로는 로그에 남기지 않습니다.\n\n" +
    "PTY, stdin 또는 소유 process 종료를 우회하는 -T/-N/-n/-f 및 multiplex·stdio 제어 옵션은 사용할 수 없습니다.\n\n" +
    "example:\n" +
    "  cat-tui ssh -i ~/.ssh/id_ed25519 -p 2222 user@example.com\n";
}

export class SshManagementController {
  readonly #environment: NodeJS.ProcessEnv | undefined;

  constructor(options: SshManagementControllerOptions = {}) {
    this.#environment = options.environment;
  }

  async run(args: readonly string[], output: CliOutput): Promise<number> {
    if (
      args.length === 0 ||
      (args.length === 1 && (args[0] === "-h" || args[0] === "--help"))
    ) {
      output.writeTrustedText(sshHelp());
      return 0;
    }
    output.diagnostic(
      "cat ssh: 명시적 clipboard 쓰기 bridge로 접속합니다. 신뢰하는 서버에만 사용하세요.",
    );
    const result = await runSshClipboardBridge(args, {
      ...(this.#environment === undefined ? {} : { environment: this.#environment }),
    });
    if (result.clipboardWrites > 0) {
      output.diagnostic(`cat ssh: clipboard 쓰기 요청 ${result.clipboardWrites}건을 처리했습니다.`);
    }
    if (result.blockedReadRequests > 0) {
      output.diagnostic(
        `cat ssh: clipboard 읽기 요청 ${result.blockedReadRequests}건을 응답 없이 차단했습니다.`,
      );
    }
    if (result.clipboardFailures > 0) {
      output.diagnostic(
        `cat ssh: clipboard 요청 ${result.clipboardFailures}건을 크기·형식·출력 제한으로 처리하지 못했습니다.`,
      );
    }
    if (!result.cleanupConfirmed) {
      output.diagnostic(
        "cat ssh: 소유 SSH process 종료를 확정하지 못했습니다. 터미널 상태와 남은 process를 확인하세요.",
      );
      return 1;
    }
    return result.exitCode;
  }
}
