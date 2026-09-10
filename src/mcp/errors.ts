import { ProtocolError } from "../core/errors.js";

export class McpError extends ProtocolError {
  override name = "McpError";
}
