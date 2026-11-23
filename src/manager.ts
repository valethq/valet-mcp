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

function baseName(serverId: string, remoteName: string): string {
  return `mcp_${clean(serverId)}__${clean(remoteName)}`.slice(0, MAX_NAME).replace(/_+$/g, "") || "mcp_tool";
}

function hashOf(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 8);
}

function suffixed(base: string, suffix: string): string {
  const prefix = base.slice(0, MAX_NAME - suffix.length - 1).replace(/_+$/g, "") || "mcp_tool";
  return `${prefix}_${suffix}`;
}

function claimName(candidate: string, used: Set<string>, seed: string): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const hash = hashOf(seed);
  for (let i = 0; ; i++) {
    const name = suffixed(candidate, i === 0 ? hash : `${hash}${i.toString(36)}`);
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const next = canonical((value as Record<string, unknown>)[key]);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

interface FetchedServer {
  server: NormalizedServer;
  connection: McpConnection;
  remote: Tool[];
}

export class McpManager {
  private servers: NormalizedServer[] = [];
  private pending = new Map<string, Promise<McpConnection>>();

  constructor(
    private ctx: PluginContext<McpPluginConfig>,
    private connect: ConnectMcp = connectMcp,
  ) {
    this.setConfig(ctx.config);
    // Tools re-read ctx.config on every list, so cmd: refs refresh from the cache.
    ctx.onConfigChange(() => undefined);
    ctx.onDispose(() => this.dispose());
  }

  get serverCount(): number {
    return this.servers.length;
  }

  setConfig(config: McpPluginConfig | undefined): void {
    const normalized = normalizeServers(config);
    for (const error of normalized.errors) this.ctx.log.warn("invalid MCP server config", { error });
    const servers = normalized.servers.filter((server) => server.active);
    if (JSON.stringify(canonical(servers)) === JSON.stringify(canonical(this.servers))) return;
    this.servers = servers;
    void this.closeAll();
  }

  async list(): Promise<ToolDefinition[]> {
    this.setConfig(this.ctx.config);
    const used = new Set<string>();
    const fetched = await Promise.all(
      this.servers.map(async (server): Promise<FetchedServer | undefined> => {
        try {
          return await this.fetchServer(server);
        } catch (error) {
          this.ctx.log.warn("MCP server unavailable", { server: server.id, error: errorName(error) });
          this.pending.delete(server.id);
          return undefined;
        }
      }),
    );
    const tools: ToolDefinition[] = [];
    for (const item of fetched) {
      if (item !== undefined)
        tools.push(...this.definitions(item.server, item.connection, item.remote, used));
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  async dispose(): Promise<void> {
    await this.closeAll();
  }

  private async fetchServer(server: NormalizedServer): Promise<FetchedServer> {
    const connection = await this.connection(server);
    try {
      return { server, connection, remote: await this.listRemote(connection, server) };
    } catch (error) {
      this.pending.delete(server.id);
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private definitions(
    server: NormalizedServer,
    connection: McpConnection,
    remote: Tool[],
    used: Set<string>,
  ): ToolDefinition[] {
    const usable = remote.filter((tool) => {
      if (tool.execution?.taskSupport !== "required") return true;
      this.ctx.log.debug("skipping task-only MCP tool", { server: server.id, tool: tool.name });
      return false;
    });
    const names = usable.map((tool) => ({ tool, base: baseName(server.id, tool.name) }));
    const counts = new Map<string, number>();
    for (const { base } of names) counts.set(base, (counts.get(base) ?? 0) + 1);
    const tools: ToolDefinition[] = [];
    for (const { tool, base } of names) {
      const seed = `${server.id}\0${tool.name}`;
      const candidate = (counts.get(base) ?? 0) > 1 ? suffixed(base, hashOf(seed)) : base;
      tools.push(this.definition(server, connection, tool, claimName(candidate, used, seed)));
    }
    return tools;
  }

  private async listRemote(connection: McpConnection, server: NormalizedServer): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: server.timeoutMs,
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
    name: string,
  ): ToolDefinition {
    const remoteName = tool.name;
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
