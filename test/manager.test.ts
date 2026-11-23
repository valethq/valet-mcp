import { expect, test } from "bun:test";
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
