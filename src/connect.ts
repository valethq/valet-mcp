import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolRequest, ListToolsRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectMcp, McpConnection } from "./types";

export const connectMcp: ConnectMcp = async (server, version) => {
  const client = new Client({ name: "valet-mcp", version }, { capabilities: {} });
  const transport =
    server.transport === "stdio"
      ? new StdioClientTransport({
          command: server.command ?? "",
          args: server.args,
          env: { ...getDefaultEnvironment(), ...server.env },
          ...(server.cwd !== undefined && { cwd: server.cwd }),
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
          requestInit: { headers: server.headers },
        });
  try {
    await client.connect(transport, { timeout: server.timeoutMs, maxTotalTimeout: server.timeoutMs });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    listTools: async (params?: ListToolsRequest["params"], options?: RequestOptions) => {
      const result = await client.listTools(params, options);
      return {
        tools: result.tools,
        ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
      };
    },
    callTool: async (params: CallToolRequest["params"], options?: RequestOptions) =>
      (await client.callTool(params, undefined, options)) as Awaited<ReturnType<McpConnection["callTool"]>>,
    close: () => client.close(),
  };
};
