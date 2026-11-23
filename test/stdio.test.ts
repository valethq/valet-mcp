import { expect, test } from "bun:test";
import { McpManager } from "../src/manager";
import { call, fakeCtx, textOf } from "./helpers";

test("connectMcp lists and calls tools over stdio", async () => {
  const ctx = fakeCtx({
    servers: [
      {
        id: "local",
        transport: "stdio",
        command: process.execPath,
        args: [new URL("./stdio-server.ts", import.meta.url).pathname],
        env: { FAKE_STDIO_TOKEN: "x" },
        timeoutMs: 5000,
      },
    ],
  });
  const manager = new McpManager(ctx);
  const tools = await manager.list();
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toMatch(/^mcp_local__stdio_echo_[0-9a-f]{8}$/);
  const result = await tools[0]?.invoke({ text: "hi" }, call());
  expect(textOf(result ?? { content: [] })).toBe('stdio:{"text":"hi"}');
  await manager.dispose();
});
