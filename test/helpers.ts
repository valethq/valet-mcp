import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AclHost, PermissionDef, PluginContext, Role, Store, ToolCall } from "@valethq/sdk";
import type { McpPluginConfig, NormalizedServer } from "../src/config";
import type { McpConnection } from "../src/types";

export function fakeConnection(
  tools: Tool[],
  result: CallToolResult = { content: [{ type: "text", text: "ok" }] },
): {
  connection: McpConnection;
  calls: { name: string; arguments?: Record<string, unknown> }[];
  closed: () => boolean;
} {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  let closed = false;
  return {
    calls,
    closed: () => closed,
    connection: {
      listTools: async () => ({ tools }),
      callTool: async (params) => {
        calls.push({
          name: params.name,
          ...(params.arguments !== undefined && { arguments: params.arguments }),
        });
        return result;
      },
      close: async () => {
        closed = true;
      },
    },
  };
}

export function fakeCtx(
  config: McpPluginConfig,
  roles: Record<string, Role> = { owner: "owner" },
  permission: PermissionDef | undefined = { summary: "Call MCP tools", default: "owner" },
): PluginContext<McpPluginConfig> {
  const acl: AclHost = {
    permission: (name) => (name === "mcp:call" ? permission : undefined),
    names: () => ["mcp:call"],
    credential: () => undefined,
  };
  const blobs = {
    put: async () => ({ id: "blob-1" }),
    path: (id: string) => `/tmp/${id}`,
  };
  const ctx = {
    plugin: { id: "valet-mcp", version: "0.1.0", dir: "/tmp/valet-mcp", manifest: {} },
    config,
    configFor: () => config,
    onConfigCheck() {},
    onConfigChange() {},
    onDispose() {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    acl,
    scopes: { maybe: () => undefined },
    store: {
      principals: { get: (id: string) => (roles[id] ? { id, role: roles[id] } : undefined) },
      sessions: { get: (id: string) => ({ id, projectId: "p" }) },
      blobs,
    } as unknown as Store,
    signal: new AbortController().signal,
  } as unknown as PluginContext<McpPluginConfig>;
  return ctx;
}

export const call = (principalId = "owner", role: Role = "owner"): ToolCall => ({
  sessionId: "s",
  runId: "r",
  callId: "c",
  role,
  caller: { plugin: "valet-agent", actor: { principalId, role } } as ToolCall["caller"],
  cwd: "/",
  signal: new AbortController().signal,
  progress() {},
});

export const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("");

export const tool = (name: string, description = "remote tool"): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
});

export const server = (id: string): NormalizedServer => ({
  id,
  label: id,
  transport: "streamable-http",
  active: true,
  url: `https://mcp.example/${id}`,
  headers: {},
  args: [],
  env: {},
  timeoutMs: 1000,
});
