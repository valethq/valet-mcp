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

function toolName(serverId: string, remoteName: string): string {
  return suffixed(baseName(serverId, remoteName), hashOf(`${serverId}\0${remoteName}`));
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

function connectionKey(server: NormalizedServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          transport: server.transport,
          url: server.url,
          headers: server.headers,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
        }),
      ),
    )
    .digest("hex");
}

function toolKey(server: NormalizedServer): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          transport: server.transport,
          url: server.url,
          headers: Object.keys(server.headers).sort(),
          command: server.command,
          args: server.args,
          env: Object.keys(server.env).sort(),
          cwd: server.cwd,
        }),
      ),
    )
    .digest("hex");
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

interface FetchedServer {
  server: NormalizedServer;
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
    // Save-time validation rejects bad server entries before they are applied.
    ctx.onConfigCheck((next) => {
      const checked = normalizeServers(next);
      if (checked.errors.length > 0) throw new Error(checked.errors.join("; "));
    });
    // Tools re-read ctx.config on every list and call, so cmd: refs refresh from the cache.
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
    const nextById = new Map(servers.map((server) => [server.id, server]));
    const changed = new Set<string>();
    for (const previous of this.servers) {
      const current = nextById.get(previous.id);
      if (current === undefined || connectionKey(current) !== connectionKey(previous)) {
        changed.add(previous.id);
      }
    }
    this.servers = servers;
    this.closeServers(changed);
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
      if (item !== undefined) tools.push(...this.definitions(item.server, item.remote, used));
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  async dispose(): Promise<void> {
    await this.closeAll();
  }

  private async fetchServer(server: NormalizedServer): Promise<FetchedServer> {
    const connection = await this.connection(server);
    try {
      return { server, remote: await this.listRemote(connection, server) };
    } catch (error) {
      this.pending.delete(server.id);
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private definitions(server: NormalizedServer, remote: Tool[], used: Set<string>): ToolDefinition[] {
    const usable = remote.filter((tool) => {
      if (tool.execution?.taskSupport !== "required") return true;
      this.ctx.log.debug("skipping task-only MCP tool", { server: server.id, tool: tool.name });
      return false;
    });
    const tools: ToolDefinition[] = [];
    for (const tool of usable) {
      const seed = `${server.id}\0${tool.name}`;
      tools.push(this.definition(server, tool, claimName(toolName(server.id, tool.name), used, seed)));
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

  private async verifyListedTool(
    connection: McpConnection,
    server: NormalizedServer,
    remoteName: string,
    expectedSchema: string,
  ): Promise<boolean> {
    const remote = await this.listRemote(connection, server);
    return remote.some(
      (candidate) =>
        candidate.name === remoteName && JSON.stringify(canonical(candidate.inputSchema)) === expectedSchema,
    );
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

  private definition(server: NormalizedServer, tool: Tool, name: string): ToolDefinition {
    const remoteName = tool.name;
    const remoteDescription = tool.description?.trim();
    const description = remoteDescription
      ? `${remoteDescription}\n\nMCP server: ${server.label} (${server.id}).`
      : `Call ${remoteName} on MCP server ${server.label} (${server.id}).`;
    const listedToolKey = toolKey(server);
    const expectedSchema = JSON.stringify(canonical(tool.inputSchema));
    let listedConnectionKey = connectionKey(server);
    const ctx = this.ctx;
    return defineTool(
      {
        name,
        description,
        inputSchema: { type: "object", ...(tool.inputSchema as Record<string, unknown>) },
        permission: PERMISSION,
        invoke: async (input, call) => {
          this.setConfig(this.ctx.config);
          const current = this.servers.find((candidate) => candidate.id === server.id);
          if (current === undefined) {
            return {
              content: [{ type: "text", text: `MCP server "${server.id}" is not active.` }],
              isError: true,
            };
          }
          if (toolKey(current) !== listedToolKey) {
            return {
              content: [
                { type: "text", text: `MCP server "${server.id}" configuration changed; refresh tools.` },
              ],
              isError: true,
            };
          }
          const currentConnectionKey = connectionKey(current);
          const connection = await this.connection(current);
          if (currentConnectionKey !== listedConnectionKey) {
            let verified = false;
            try {
              verified = await this.verifyListedTool(connection, current, remoteName, expectedSchema);
            } catch (error) {
              return {
                content: [
                  {
                    type: "text",
                    text: `MCP server "${server.id}" is unavailable: ${errorName(error)}`,
                  },
                ],
                isError: true,
              };
            }
            if (!verified) {
              return {
                content: [{ type: "text", text: `MCP server "${server.id}" tools changed; refresh tools.` }],
                isError: true,
              };
            }
            listedConnectionKey = currentConnectionKey;
          }
          const timeout = current.timeoutMs;
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

  private closeServers(ids: ReadonlySet<string>): void {
    const closing: Promise<unknown>[] = [];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (pending === undefined) continue;
      this.pending.delete(id);
      closing.push(
        pending.then(
          (connection) => connection.close(),
          () => undefined,
        ),
      );
    }
    if (closing.length > 0) void Promise.allSettled(closing);
  }

  private async closeAll(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
  }
}
