import { expect, test } from "bun:test";
import { allowedTools } from "@valethq/sdk";
import { McpManager } from "../src/manager";
import { call, fakeConnection, fakeCtx, textOf, tool } from "./helpers";

const config = {
  servers: [
    { id: "github", label: "GitHub", url: "https://mcp.example/github" },
    { id: "local", transport: "stdio" as const, command: "node", args: ["server.js"], enabled: true },
    { id: "off", enabled: false, url: "https://mcp.example/off" },
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
  const ctx = fakeCtx(config);
  const manager = new McpManager(ctx, async (server) => {
    const found = byId.get(server.id);
    if (!found) throw new Error(`unexpected server ${server.id}`);
    return found.connection;
  });
  return { manager, github, local };
}

test("lists remote MCP tools as namespaced Valet tools", async () => {
  const { manager, github, local } = managerFor();
  const tools = await manager.list();
  expect(tools.map((t) => t.name)).toEqual(["mcp_github__search_issues", "mcp_local__run_command"]);
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
