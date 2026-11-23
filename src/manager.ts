import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type PluginContext, type ToolDefinition, defineTool } from "@valethq/sdk";
import { type McpPluginConfig, type NormalizedServer, normalizeServers } from "./config";
import { connectMcp } from "./connect";
import { toToolResult } from "./result";
import type { ConnectMcp, McpConnection } from "./types";

const PERMISSION = "mcp:call";
const MAX_NAME = 64;

const clean = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");

function uniqueName(serverId: string, remoteName: string, used: Set<string>): string {
  const base = `mcp_${clean(serverId)}__${clean(remoteName)}`.slice(0, MAX_NAME).replace(/_+$/g, "");
  const first = base || "mcp_tool";
  if (!used.has(first)) {
    used.add(first);
    return first;
  }
  const hash = createHash("sha256").update(`${serverId}\0${remoteName}`).digest("hex").slice(0, 8);
  for (let i = 0; ; i++) {
    const suffix = i === 0 ? hash : `${hash}${i.toString(36)}`;
    const candidate = `${first.slice(0, MAX_NAME - suffix.length - 1)}_${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export class McpManager {
  private servers: NormalizedServer[] = [];
  private pending = new Map<string, Promise<McpConnection>>();

  constructor(
    private ctx: PluginContext<McpPluginConfig>,
    private connect: ConnectMcp = connectMcp,
  ) {
    this.setConfig(ctx.config);
    ctx.onConfigChange((next) => this.setConfig(next));
    ctx.onDispose(() => this.dispose());
  }

  get serverCount(): number {
    return this.servers.length;
  }

  setConfig(config: McpPluginConfig | undefined): void {
    const normalized = normalizeServers(config);
    for (const error of normalized.errors) this.ctx.log.warn("invalid MCP server config", { error });
    this.servers = normalized.servers.filter((server) => server.enabled);
    void this.closeAll();
  }

  async list(): Promise<ToolDefinition[]> {
    const groups = await Promise.all(
      this.servers.map(async (server) => {
        try {
          return await this.toolsFor(server);
        } catch (error) {
          this.ctx.log.warn("MCP server unavailable", {
            server: server.id,
            error: error instanceof Error ? error.message : String(error),
          });
          this.pending.delete(server.id);
          return [] as ToolDefinition[];
        }
      }),
    );
    return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
  }

  async dispose(): Promise<void> {
    await this.closeAll();
  }

  private async toolsFor(server: NormalizedServer): Promise<ToolDefinition[]> {
    const connection = await this.connection(server);
    let remote: Tool[];
    try {
      remote = await this.listRemote(connection, server);
    } catch (error) {
      this.pending.delete(server.id);
      await connection.close().catch(() => undefined);
      throw error;
    }
    const used = new Set<string>();
    const tools: ToolDefinition[] = [];
    for (const tool of remote) {
      if (tool.execution?.taskSupport === "required") {
        this.ctx.log.debug("skipping task-only MCP tool", { server: server.id, tool: tool.name });
        continue;
      }
      tools.push(this.definition(server, connection, tool, used));
    }
    return tools;
  }

  private async listRemote(connection: McpConnection, server: NormalizedServer): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: Math.min(server.timeoutMs, 10_000),
        maxTotalTimeout: server.timeoutMs,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private connection(server: NormalizedServer): Promise<McpConnection> {
    const existing = this.pending.get(server.id);
    if (existing !== undefined) return existing;
    const pending = this.connect(server, this.ctx.plugin.version).catch((error: unknown) => {
      this.pending.delete(server.id);
      throw error;
    });
    this.pending.set(server.id, pending);
    return pending;
  }

  private definition(
    server: NormalizedServer,
    connection: McpConnection,
    tool: Tool,
    used: Set<string>,
  ): ToolDefinition {
    const remoteName = tool.name;
    const name = uniqueName(server.id, remoteName, used);
    const remoteDescription = tool.description?.trim();
    const description = remoteDescription
      ? `${remoteDescription}\n\nMCP server: ${server.label} (${server.id}).`
      : `Call ${remoteName} on MCP server ${server.label} (${server.id}).`;
    const timeout = server.timeoutMs;
    const ctx = this.ctx;
    return defineTool(
      {
        name,
        description,
        inputSchema: { type: "object", ...(tool.inputSchema as Record<string, unknown>) },
        permission: PERMISSION,
        invoke: async (input, call) => {
          const result = await connection.callTool(
            { name: remoteName, arguments: input as Record<string, unknown> },
            {
              signal: AbortSignal.any([call.signal, AbortSignal.timeout(timeout)]),
              timeout,
              maxTotalTimeout: timeout,
            },
          );
          return toToolResult(result, ctx.store.blobs);
        },
      },
      ctx,
    );
  }

  private async closeAll(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
  }
}
