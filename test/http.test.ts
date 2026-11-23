import { afterAll, expect, test } from "bun:test";
import { McpManager } from "../src/manager";
import { call, fakeCtx, textOf } from "./helpers";

const requests: { method: string | null; body: { method?: string; params?: Record<string, unknown> } }[] = [];
let auth: string | null = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    auth = req.headers.get("authorization");
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const body = (await req.json()) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };
    requests.push({ method: req.headers.get("mcp-protocol-version"), body });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = (() => {
      switch (body.method) {
        case "initialize":
          return {
            protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "0.0.1" },
          };
        case "tools/list":
          return {
            tools: [
              {
                name: "echo.text",
                description: "Echo text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          };
        case "tools/call":
          return { content: [{ type: "text", text: `echo:${JSON.stringify(body.params?.arguments)}` }] };
        default:
          return {};
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  },
});

afterAll(async () => {
  await server.stop(true);
});

test("connectMcp lists and calls tools over Streamable HTTP", async () => {
  const ctx = fakeCtx({
    servers: [
      {
        id: "fake",
        url: `http://127.0.0.1:${server.port}/mcp`,
        headers: { Authorization: "Bearer test-secret" },
        timeoutMs: 5000,
      },
    ],
  });
  const manager = new McpManager(ctx);
  const tools = await manager.list();
  expect(tools.map((t) => t.name)).toEqual(["mcp_fake__echo_text"]);
  const result = await tools[0]?.invoke({ text: "hello" }, call());
  expect(textOf(result ?? { content: [] })).toBe('echo:{"text":"hello"}');
  expect(auth).toBe("Bearer test-secret");
  expect(requests.map((r) => r.body.method)).toContain("initialize");
  expect(requests.map((r) => r.body.method)).toContain("tools/list");
  expect(requests.map((r) => r.body.method)).toContain("tools/call");
  await manager.dispose();
});
