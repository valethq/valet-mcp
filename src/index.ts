import { allowedTools, definePlugin } from "@valethq/sdk";
import type { McpPluginConfig } from "./config";
import { McpManager } from "./manager";

export default definePlugin<McpPluginConfig>({
  activate(ctx) {
    const manager = new McpManager(ctx);
    ctx.scopes.provide("tools", {
      list: async (scope) => allowedTools(ctx, scope, await manager.list()),
    });
    ctx.log.info("MCP tools ready", { servers: manager.serverCount });
  },
});
