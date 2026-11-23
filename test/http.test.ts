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
              {
                name: "tuple",
                description: "Tuple output",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { pair: { type: "array", prefixItems: [{ type: "string" }], items: false } },
                  required: ["pair"],
                },
              },
            ],
          };
        case "tools/call":
          if (body.params?.name === "tuple") {
            return { content: [{ type: "text", text: "tuple-ok" }], structuredContent: { pair: ["ok"] } };
          }
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
  const names = tools.map((t) => t.name);
  expect(names[0]).toMatch(/^mcp_fake__echo_text_[0-9a-f]{8}$/);
  expect(names[1]).toMatch(/^mcp_fake__tuple_[0-9a-f]{8}$/);
  const result = await tools[0]?.invoke({ text: "hello" }, call());
  expect(textOf(result ?? { content: [] })).toBe('echo:{"text":"hello"}');
  const tuple = tools.find((t) => t.name.startsWith("mcp_fake__tuple_"));
  const tupleResult = await tuple?.invoke({}, call());
  expect(tupleResult?.isError).not.toBe(true);
  expect(textOf(tupleResult ?? { content: [] })).toContain("tuple-ok");
  expect(auth).toBe("Bearer test-secret");
  expect(requests.map((r) => r.body.method)).toContain("initialize");
  expect(requests.map((r) => r.body.method)).toContain("tools/list");
  expect(requests.map((r) => r.body.method)).toContain("tools/call");
  await manager.dispose();
});
