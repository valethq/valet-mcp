import process from "node:process";

let buffer = "";

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message: { id?: string | number; method?: string; params?: Record<string, unknown> }): void {
  if (message.method === "notifications/initialized" || message.method === undefined) return;
  const result = (() => {
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-stdio-mcp", version: "0.0.1" },
        };
      case "tools/list":
        return {
          tools: [
            {
              name: "stdio.echo",
              description: "Echo over stdio",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        };
      case "tools/call":
        return { content: [{ type: "text", text: `stdio:${JSON.stringify(message.params?.arguments)}` }] };
      default:
        return {};
    }
  })();
  send({ jsonrpc: "2.0", id: message.id, result });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handle(JSON.parse(line) as Parameters<typeof handle>[0]);
  }
});
