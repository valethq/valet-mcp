import { expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { allowedTools } from "@valethq/sdk";
import { McpManager } from "../src/manager";
import { call, fakeConnection, fakeCtx, textOf, tool } from "./helpers";

const config = {
  servers: [
    { id: "github", label: "GitHub", url: "https://mcp.example/github" },
    { id: "local", transport: "stdio" as const, command: "node", args: ["server.js"], active: true },
    { id: "off", active: false, url: "https://mcp.example/off" },
  ],
};

function managerFor() {
  const github = fakeConnection([
    tool("search.issues", "Search issues"),
    { ...tool("task.tool"), execution: { taskSupport: "required" } },
  ]);
  const local = fakeConnection([tool("run.command", "Run a command")]);
  const byId = new Map([
    ["github", github],
    ["local", local],
  ]);
  const fresh = structuredClone(config);
  const ctx = fakeCtx(fresh);
  const manager = new McpManager(ctx, async (server) => {
    const found = byId.get(server.id);
    if (!found) throw new Error(`unexpected server ${server.id}`);
    return found.connection;
  });
  return { manager, github, local, config: fresh };
}

test("lists remote MCP tools as namespaced Valet tools", async () => {
  const { manager, github, local } = managerFor();
  const tools = await manager.list();
  const names = tools.map((t) => t.name);
  expect(names[0]).toMatch(/^mcp_github__search_issues_[0-9a-f]{8}$/);
  expect(names[1]).toMatch(/^mcp_local__run_command_[0-9a-f]{8}$/);
  expect(tools[0]?.description).toContain("Search issues");
  expect(tools[0]?.description).toContain("GitHub (github)");
  expect(tools[0]?.inputSchema).toMatchObject({ type: "object", required: ["q"] });
  expect(github.calls).toEqual([]);
  expect(local.calls).toEqual([]);
  await manager.dispose();
  expect(github.closed()).toBe(true);
  expect(local.closed()).toBe(true);
});

test("calls the remote tool with the original name and mapped arguments", async () => {
  const { manager, github } = managerFor();
  const [definition] = await manager.list();
  const result = await definition?.invoke({ q: "valet" }, call());
  expect(github.calls).toEqual([{ name: "search.issues", arguments: { q: "valet" } }]);
  expect(textOf(result ?? { content: [] })).toBe("ok");
  await manager.dispose();
});

test("ACL denies callers without mcp:call", async () => {
  const ctx = fakeCtx(config, { guest: "guest" });
  const github = fakeConnection([tool("search")]);
  const manager = new McpManager(ctx, async () => github.connection);
  const [definition] = await manager.list();
  const result = await definition?.invoke({}, call("guest", "guest"));
  expect(result?.isError).toBe(true);
  expect(textOf(result ?? { content: [] })).toContain("denied");
  expect(github.calls).toEqual([]);
  await manager.dispose();
});

test("allowedTools applies the same ACL to dynamic definitions", async () => {
  const { manager } = managerFor();
  const ctx = fakeCtx(config);
  const tools = await manager.list();
  const allowed = allowedTools(ctx, { sessionId: "s", role: "owner", caller: call().caller }, tools);
  const denied = allowedTools(
    ctx,
    { sessionId: "s", role: "guest", caller: call("guest", "guest").caller },
    tools,
  );
  expect(allowed).toHaveLength(2);
  expect(denied).toHaveLength(0);
  await manager.dispose();
});

test("re-reads ctx config on each list", async () => {
  const { manager, local, config } = managerFor();
  expect(await manager.list()).toHaveLength(2);
  const second = (config.servers as { active?: boolean }[])[1];
  if (second !== undefined) second.active = false;
  const tools = await manager.list();
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toMatch(/^mcp_github__search_issues_[0-9a-f]{8}$/);
  expect(local.closed()).toBe(true);
  await manager.dispose();
});

test("saved tools stop calling after a server is deactivated", async () => {
  const { manager, local, config } = managerFor();
  const tools = await manager.list();
  const localTool = tools.find((t) => t.name.startsWith("mcp_local__run_command_"));
  expect(localTool).toBeDefined();
  const second = (config.servers as { active?: boolean }[])[1];
  if (second !== undefined) second.active = false;
  const result = await localTool?.invoke({}, call());
  expect(result?.isError).toBe(true);
  expect(textOf(result ?? { content: [] })).toContain("not active");
  expect(local.calls).toEqual([]);
  expect(local.closed()).toBe(true);
  await manager.dispose();
});

test("saved tools stay pinned to the config they were listed with", async () => {
  const { manager, github, local, config } = managerFor();
  const tools = await manager.list();
  const githubTool = tools.find((t) => t.name.startsWith("mcp_github__search_issues_"));
  const localTool = tools.find((t) => t.name.startsWith("mcp_local__run_command_"));
  expect(githubTool).toBeDefined();
  expect(localTool).toBeDefined();
  const servers = config.servers as { id: string; url?: string }[];
  const githubServer = servers[0];
  if (githubServer !== undefined) githubServer.url = "https://mcp.example/github-v2";

  const localResult = await localTool?.invoke({ q: "still local" }, call());
  expect(localResult?.isError).not.toBe(true);
  expect(local.calls).toEqual([{ name: "run.command", arguments: { q: "still local" } }]);
  expect(local.closed()).toBe(false);

  const githubResult = await githubTool?.invoke({ q: "wrong server" }, call());
  expect(githubResult?.isError).toBe(true);
  expect(textOf(githubResult ?? { content: [] })).toContain("configuration changed");
  expect(github.calls).toEqual([]);
  await manager.dispose();
});

test("credential refresh reconnects and keeps listed tools callable", async () => {
  const url = "https://mcp.example/svc";
  const config = { servers: [{ id: "svc", url, headers: { Authorization: "Bearer old" } }] };
  const ctx = fakeCtx(config);
  const oldServer = fakeConnection([tool("echo")]);
  const newServer = fakeConnection([tool("echo")]);
  const manager = new McpManager(ctx, async (server) => {
    const auth = server.headers.Authorization;
    if (auth === "Bearer old") return oldServer.connection;
    if (auth === "Bearer new") return newServer.connection;
    throw new Error(`unexpected auth ${auth}`);
  });
  const listed = (await manager.list())[0];
  if (listed === undefined) throw new Error("missing tool");
  const svc = config.servers[0];
  if (svc !== undefined) svc.headers.Authorization = "Bearer new";

  const result = await listed.invoke({ q: "refresh" }, call());
  expect(result.isError).not.toBe(true);
  expect(textOf(result)).toBe("ok");
  expect(oldServer.calls).toEqual([]);
  expect(newServer.calls).toEqual([{ name: "echo", arguments: { q: "refresh" } }]);
  await manager.dispose();
});

test("header backend change does not call a changed tool surface", async () => {
  const url = "https://mcp.example/svc";
  const config = { servers: [{ id: "svc", url, headers: { Authorization: "Bearer old" } }] };
  const ctx = fakeCtx(config);
  const oldServer = fakeConnection([tool("echo")]);
  const changed: Tool = {
    ...tool("echo"),
    inputSchema: { type: "object", properties: { other: { type: "number" } } },
  };
  const newServer = fakeConnection([changed]);
  const manager = new McpManager(ctx, async (server) => {
    const auth = server.headers.Authorization;
    if (auth === "Bearer old") return oldServer.connection;
    if (auth === "Bearer new") return newServer.connection;
    throw new Error(`unexpected auth ${auth}`);
  });
  const listed = (await manager.list())[0];
  if (listed === undefined) throw new Error("missing tool");
  const svc = config.servers[0];
  if (svc !== undefined) svc.headers.Authorization = "Bearer new";

  const result = await listed.invoke({ q: "refresh" }, call());
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("tools changed");
  expect(oldServer.calls).toEqual([]);
  expect(newServer.calls).toEqual([]);
  await manager.dispose();
});

test("verification uses the caller abort signal", async () => {
  const url = "https://mcp.example/svc";
  const config = { servers: [{ id: "svc", url, headers: { Authorization: "Bearer old" } }] };
  const ctx = fakeCtx(config);
  const oldServer = fakeConnection([tool("echo")]);
  const newServer = fakeConnection([tool("echo")]);
  const seen: (AbortSignal | undefined)[] = [];
  newServer.connection.listTools = async (_params, options) => {
    seen.push(options?.signal);
    const signal = options?.signal;
    if (signal === undefined) throw new Error("missing signal");
    await new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { tools: [] };
  };
  const manager = new McpManager(ctx, async (server) => {
    const auth = server.headers.Authorization;
    if (auth === "Bearer old") return oldServer.connection;
    if (auth === "Bearer new") return newServer.connection;
    throw new Error(`unexpected auth ${auth}`);
  });
  const listed = (await manager.list())[0];
  if (listed === undefined) throw new Error("missing tool");
  const svc = config.servers[0];
  if (svc !== undefined) svc.headers.Authorization = "Bearer new";
  const controller = new AbortController();
  const toolCall = { ...call(), signal: controller.signal };
  const pending = listed.invoke({ q: "refresh" }, toolCall);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();

  const result = await pending;
  expect(result.isError).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.aborted).toBe(true);
  expect(oldServer.calls).toEqual([]);
  expect(newServer.calls).toEqual([]);
  await manager.dispose();
});

test("rediscovery after endpoint change routes calls to the replacement", async () => {
  const oldUrl = "https://old.example/mcp";
  const newUrl = "https://new.example/mcp";
  const config = { servers: [{ id: "svc", url: oldUrl }] };
  const ctx = fakeCtx(config);
  const oldServer = fakeConnection([tool("echo")]);
  const newServer = fakeConnection([tool("echo")]);
  const manager = new McpManager(ctx, async (server) => {
    if (server.url === oldUrl) return oldServer.connection;
    if (server.url === newUrl) return newServer.connection;
    throw new Error(`unexpected ${server.url}`);
  });
  const first = await manager.list();
  const firstTool = first[0];
  expect(firstTool?.name).toMatch(/^mcp_svc__echo_[0-9a-f]{8}$/);
  const svc = config.servers[0];
  if (svc !== undefined) svc.url = newUrl;

  const stale = await firstTool?.invoke({ q: "old" }, call());
  expect(stale?.isError).toBe(true);
  expect(textOf(stale ?? { content: [] })).toContain("configuration changed");

  const second = await manager.list();
  const secondTool = second[0];
  expect(secondTool?.name).toBe(firstTool?.name);
  const result = await secondTool?.invoke({ q: "new" }, call());
  expect(result?.isError).not.toBe(true);
  expect(oldServer.calls).toEqual([]);
  expect(newServer.calls).toEqual([{ name: "echo", arguments: { q: "new" } }]);
  await manager.dispose();
});

test("keeps colliding remote names unique and stable", async () => {
  const ctx = fakeCtx({ servers: [{ id: "demo", url: "https://mcp.example/demo" }] });
  const conn = fakeConnection([tool("a.b"), tool("a b"), tool("a_b")]);
  const manager = new McpManager(ctx, async () => conn.connection);
  const names = (await manager.list()).map((t) => t.name);
  expect(names).toHaveLength(3);
  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name).toMatch(/^mcp_demo__a_b_[0-9a-f]{8}$/);
  await manager.dispose();
});
