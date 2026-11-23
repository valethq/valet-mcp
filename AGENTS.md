# valet-mcp

tools@1 proxy for tools exposed by configured MCP servers.

Rules for this repo. The contract lives in `../valet-core`.

- Runtime: Bun 1.4.4 (`~/.npm-global/bin/bun`). Strict TypeScript.
- Contract: `../valet-core/docs/ARCHITECTURE.md` is normative. Read it and the SDK types in `../valet-core/packages/sdk/src/*.ts` before coding. Do not guess signatures. Don't edit the spec unless the human tells you to. You may read `../valet-core/packages/core/src/**` to understand behaviour, but never import it.
- Imports: only `@valethq/sdk`, `@modelcontextprotocol/sdk`, this plugin's own dependencies, and `node:*` / `bun:*`. Never import `@valethq/core`, another plugin, or any `../valet-*` path.
- Scope types: the SDK declares `inference`, `tools`, `platform`, `identity` and `context`; import those from `@valethq/sdk`.
- No private APIs: no `ctx.internal`, no core-only hooks, no bypass flags. Everything goes through the `PluginContext` passed to `activate`.
- Dependencies: avoid runtime dependencies. Add one only when it is the point of the plugin or the plugin cannot reasonably work without it. Pin exact versions. Dev tooling (typescript, `@types/bun`, `@biomejs/biome`) is fine.
- Tests live in `test/`. Unit tests use a small fake `PluginContext`; `http.test.ts` and `stdio.test.ts` run the real MCP SDK client against local fake servers only.
- Checks, all green before you finish: `bun run typecheck`, `bun run lint` (auto-fix with `bunx biome check --write .`), `bun test`.
- Keep the existing `package.json` scripts, `tsconfig.json` and `biome.json`.
- Small files named after what they hold. Minimal comments. No dead code. Add a one-line `// spec-gap:` comment where the spec is silent.
- Git: commit when the work is finished and the checks pass, unless it is extremely large, breaking or unfinished. Don't push unless asked. Author and committer rules are in `../AGENTS.md`.
- Finish with a short summary of what you built and the results of each check.
