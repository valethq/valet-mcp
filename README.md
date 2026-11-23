# valet-mcp

Valet tools backed by MCP servers you configure in Settings.

Add a server under **Tools → MCP Servers**. Streamable HTTP servers take a URL and optional headers; stdio servers take a command, args and environment. Remote HTTP endpoints must use `https` (`http` is only allowed for loopback servers). Header and environment values can use Valet secret and file references, for example `Bearer ${secret:github_token}`.

Set a server's **Active** flag to false to ignore it. Each remote tool is listed as `mcp_<server-id>__<tool-name>_<hash>` (the hash keeps names stable when servers change) and calls are guarded by the `mcp:call` ACL permission.
