export const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

export type ClipboardWriteOrigin = "user_command" | "user_selection";

export interface ClipboardWriteRequest {
  readonly text: string;
  readonly origin: ClipboardWriteOrigin;
  readonly signal?: AbortSignal;
}

export type ClipboardWriteResult =
  | { readonly status: "written"; readonly adapter: string }
  | { readonly status: "empty" }
  | { readonly status: "too_large"; readonly maximumBytes: number }
  | { readonly status: "unavailable" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed" };

/**
 * Clipboard writes are only reached from an explicit user action. This boundary
 * intentionally has no clipboard-read operation and no terminal OSC support.
 */
export interface ClipboardWriter {
  writeText(request: ClipboardWriteRequest): Promise<ClipboardWriteResult>;
}
