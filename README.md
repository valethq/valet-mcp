# valet-mcp

Valet tools backed by MCP servers you configure in Settings.

Add a server under **Tools → MCP Servers**. Streamable HTTP servers take a URL and optional headers; stdio servers take a command, args and environment. Header and environment values can use Valet secret and file references, for example `Bearer ${secret:github_token}`.

Each remote tool is listed as `mcp_<server-id>__<tool-name>` and calls are guarded by the `mcp:call` ACL permission.
