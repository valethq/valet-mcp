import { expect, test } from "bun:test";
import { normalizeServers } from "../src/config";

test("normalizes active HTTP and stdio servers", () => {
  const result = normalizeServers({
    servers: [
      { id: "github", label: "GitHub", url: "https://mcp.example", headers: { Authorization: "Bearer x" } },
      { id: "local", transport: "stdio", command: "node", args: ["server.js"], active: false },
      { id: "bad id" },
      { id: "missing-url" },
    ],
  });
  expect(result.errors).toEqual([
    "servers[2].id must match /^[a-z0-9][a-z0-9-]{0,62}$/",
    "servers[3].url is required for streamable-http",
  ]);
  expect(result.servers.map((s) => [s.id, s.transport, s.active, s.timeoutMs])).toEqual([
    ["github", "streamable-http", true, 60_000],
    ["local", "stdio", false, 60_000],
  ]);
  expect(result.servers[0]?.headers).toEqual({ Authorization: "Bearer x" });
});

test("requires https except for loopback HTTP", () => {
  const result = normalizeServers({
    servers: [
      { id: "remote", url: "http://mcp.example" },
      { id: "local", url: "http://127.0.0.1:8787/mcp" },
      { id: "alias", url: "http://127.0.0.2:8787/mcp" },
    ],
  });
  expect(result.errors).toEqual([
    "servers[0].url must use https (http is only allowed for loopback servers)",
  ]);
  expect(result.servers.map((s) => s.id)).toEqual(["local", "alias"]);
});
