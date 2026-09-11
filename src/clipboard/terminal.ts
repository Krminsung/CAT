import {
  MAX_CLIPBOARD_TEXT_BYTES,
  type ClipboardWriteRequest,
  type ClipboardWriteResult,
  type ClipboardWriter,
} from "./types.js";
import { LocalClipboardWriter } from "./local.js";

const MAX_OSC52_PAYLOAD_BYTES = 100_000;
export const MAX_OSC52_TEXT_BYTES = 74_994;
const SCREEN_PASSTHROUGH_CHUNK = 200;

export interface TerminalControlWriter {
  write(data: string): unknown;
}

export interface Osc52ClipboardWriterOptions {
  readonly output: TerminalControlWriter;
  readonly enabled: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface UserRequestedClipboardWriterOptions extends Osc52ClipboardWriterOptions {
  readonly local?: ClipboardWriter;
}

function validRequest(request: ClipboardWriteRequest): boolean {
  return typeof request.text === "string" &&
    (request.origin === "user_command" || request.origin === "user_selection");
}

function tmuxPassthrough(sequence: string): string {
  return `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
}

function screenPassthrough(sequence: string): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < sequence.length; offset += SCREEN_PASSTHROUGH_CHUNK) {
    chunks.push(`\u001bP${sequence.slice(offset, offset + SCREEN_PASSTHROUGH_CHUNK)}\u001b\\`);
  }
  return chunks.join("");
}

function terminalSequence(
  payload: string,
  environment: NodeJS.ProcessEnv,
): { readonly sequence: string; readonly adapter: string } {
  const osc52 = `\u001b]52;c;${payload}\u0007`;
  if (environment.TMUX) {
    return Object.freeze({ sequence: tmuxPassthrough(osc52), adapter: "tmux-osc52" });
  }
  if ((environment.TERM ?? "").startsWith("screen")) {
    return Object.freeze({ sequence: screenPassthrough(osc52), adapter: "screen-osc52" });
  }
  return Object.freeze({ sequence: osc52, adapter: "osc52" });
}

/**
 * Emits an OSC52 write only for an already-authorized user clipboard action.
 * It intentionally exposes no read/query operation and never parses terminal content.
 */
export class Osc52ClipboardWriter implements ClipboardWriter {
  readonly #output: TerminalControlWriter;
  readonly #enabled: boolean;
  readonly #environment: NodeJS.ProcessEnv;
  #writing = false;

  constructor(options: Osc52ClipboardWriterOptions) {
    this.#output = options.output;
    this.#enabled = options.enabled;
    this.#environment = options.environment ?? process.env;
  }

  async writeText(request: ClipboardWriteRequest): Promise<ClipboardWriteResult> {
    if (!validRequest(request)) return Object.freeze({ status: "failed" });
    if (!request.text) return Object.freeze({ status: "empty" });
    const textBytes = Buffer.byteLength(request.text, "utf8");
    if (textBytes > MAX_CLIPBOARD_TEXT_BYTES || textBytes > MAX_OSC52_TEXT_BYTES) {
      return Object.freeze({ status: "too_large", maximumBytes: MAX_OSC52_TEXT_BYTES });
    }
    if (request.signal?.aborted) return Object.freeze({ status: "cancelled" });
    if (!this.#enabled) return Object.freeze({ status: "unavailable" });
    if (this.#writing) return Object.freeze({ status: "failed" });
    const payload = Buffer.from(request.text, "utf8").toString("base64");
    if (Buffer.byteLength(payload, "ascii") > MAX_OSC52_PAYLOAD_BYTES) {
      return Object.freeze({ status: "too_large", maximumBytes: MAX_OSC52_TEXT_BYTES });
    }

    this.#writing = true;
    try {
      if (request.signal?.aborted) return Object.freeze({ status: "cancelled" });
      const generated = terminalSequence(payload, this.#environment);
      this.#output.write(generated.sequence);
      return Object.freeze({ status: "written", adapter: generated.adapter });
    } catch {
      return Object.freeze({ status: "failed" });
    } finally {
      this.#writing = false;
    }
  }
}

/**
 * Tries the local desktop adapter first and uses host-generated OSC52 only as a
 * fallback. Both paths require the caller to label an explicit user action.
 */
export class UserRequestedClipboardWriter implements ClipboardWriter {
  readonly #local: ClipboardWriter;
  readonly #terminal: ClipboardWriter;

  constructor(options: UserRequestedClipboardWriterOptions) {
    this.#local = options.local ?? new LocalClipboardWriter({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    this.#terminal = new Osc52ClipboardWriter(options);
  }

  async writeText(request: ClipboardWriteRequest): Promise<ClipboardWriteResult> {
    const local = await this.#local.writeText(request);
    if (
      local.status === "written" ||
      local.status === "empty" ||
      local.status === "too_large" ||
      local.status === "cancelled"
    ) {
      return local;
    }
    const terminal = await this.#terminal.writeText(request);
    if (terminal.status === "unavailable" && local.status === "failed") return local;
    return terminal;
  }
}
