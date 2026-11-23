import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedServer } from "./config";

export interface McpConnection {
  listTools(
    params?: ListToolsRequest["params"],
    options?: RequestOptions,
  ): Promise<{
    tools: Tool[];
    nextCursor?: string;
  }>;
  callTool(params: CallToolRequest["params"], options?: RequestOptions): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type ConnectMcp = (server: NormalizedServer, version: string) => Promise<McpConnection>;
