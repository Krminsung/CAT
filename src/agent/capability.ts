import type { ProviderToolSpec } from "../core/provider.js";

const LOCAL_ACCESS_DENIAL = /(?:로컬|작업\s*공간|파일\s*시스템|파일)(?:[\s\S]{0,60})(?:접근|읽|확인|조회)(?:[\s\S]{0,30})(?:할\s*수\s*없|권한이?\s*없|못합니다)|\b(?:cannot|can't|unable\s+to|do\s+not\s+have\s+(?:direct\s+)?access\s+to)\s+(?:directly\s+)?(?:access\s+|read\s+|inspect\s+)?(?:your\s+|the\s+)?(?:local\s+(?:files?|system)|files?\b|filesystem|workspace)/iu;
const MCP_ABSENCE = /(?:CAT|이\s*(?:클라이언트|호스트))(?:[\s\S]{0,35})MCP(?:[\s\S]{0,20})(?:지원하지\s*않|지원하지\s*못|지원이\s*없)|\b(?:CAT|this\s+(?:host|client))\s+(?:does\s+not|doesn't)\s+support\s+MCP\b/iu;

/** A capability reminder, never a permission grant or an automatic tool call. */
export function capabilityFeedback(
  text: string,
  tools: readonly ProviderToolSpec[],
): string | undefined {
  const names = new Set(tools.map((tool) => tool.name));
  const local = ["list_files", "read_file", "search_text", "run_command"]
    .filter((name) => names.has(name));
  const mcp = ["list_mcp_servers", "add_mcp_server", "remove_mcp_server"]
    .filter((name) => names.has(name));
  const subject = text.slice(0, 8_192);
  if (!(
    (local.length > 0 && LOCAL_ACCESS_DENIAL.test(subject)) ||
    (mcp.length > 0 && MCP_ABSENCE.test(subject))
  )) return undefined;
  return "Host capability reminder: this conversation runs inside CAT. " +
    `Currently exposed local tools: ${JSON.stringify(local)}; stdio MCP management: ${JSON.stringify(mcp)}. ` +
    "Reconsider the original request using these actual capabilities, not a browser-chat assumption. " +
    "Use an appropriate tool only if the user authorized the task. Availability does not grant permission, " +
    "prove remote access, provide credentials or enable unsupported protocols. Respect all denials, " +
    "scope restrictions and requests not to execute commands. Do not manufacture a successful result.";
}
