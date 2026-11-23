import { expect, test } from "bun:test";
import { normalizeServers } from "../src/config";

test("normalizes enabled HTTP and stdio servers", () => {
  const result = normalizeServers({
    servers: [
      { id: "github", label: "GitHub", url: "https://mcp.example", headers: { Authorization: "Bearer x" } },
      { id: "local", transport: "stdio", command: "node", args: ["server.js"], enabled: false },
      { id: "bad id" },
      { id: "missing-url" },
    ],
  });
  expect(result.errors).toEqual([
    "servers[2].id must match /^[a-z0-9][a-z0-9-]{0,62}$/",
    "servers[3].url is required for streamable-http",
  ]);
  expect(result.servers.map((s) => [s.id, s.transport, s.enabled, s.timeoutMs])).toEqual([
    ["github", "streamable-http", true, 60_000],
    ["local", "stdio", false, 60_000],
  ]);
  expect(result.servers[0]?.headers).toEqual({ Authorization: "Bearer x" });
});
