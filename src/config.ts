export type TransportKind = "streamable-http" | "stdio";

export interface McpServerConfig {
  id: string;
  label?: string;
  transport?: TransportKind;
  enabled?: boolean;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface McpPluginConfig {
  servers?: McpServerConfig[];
}

export interface NormalizedServer {
  id: string;
  label: string;
  transport: TransportKind;
  enabled: boolean;
  url?: string;
  headers: Record<string, string>;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface NormalizeResult {
  servers: NormalizedServer[];
  errors: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_TIMEOUT_MS = 60_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const stringMap = (v: unknown): Record<string, string> | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) if (typeof value === "string") out[k] = value;
  return out;
};

export function normalizeServers(config: McpPluginConfig | undefined): NormalizeResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  const servers: NormalizedServer[] = [];
  for (const [index, raw] of (config?.servers ?? []).entries()) {
    const at = `servers[${index}]`;
    const id = str(raw?.id);
    if (!id || !ID.test(id)) {
      errors.push(`${at}.id must match ${ID}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${at}.id duplicates "${id}"`);
      continue;
    }
    seen.add(id);
    const transport = raw?.transport === "stdio" ? "stdio" : "streamable-http";
    const url = str(raw?.url);
    const command = str(raw?.command);
    if (transport === "streamable-http" && url === undefined) {
      errors.push(`${at}.url is required for streamable-http`);
      continue;
    }
    if (transport === "stdio" && command === undefined) {
      errors.push(`${at}.command is required for stdio`);
      continue;
    }
    servers.push({
      id,
      label: str(raw?.label) ?? id,
      transport,
      enabled: raw?.enabled !== false,
      ...(url !== undefined && { url }),
      headers: stringMap(raw?.headers) ?? {},
      ...(command !== undefined && { command }),
      args: strings(raw?.args),
      env: stringMap(raw?.env) ?? {},
      ...(str(raw?.cwd) !== undefined && { cwd: str(raw?.cwd) }),
      timeoutMs:
        typeof raw?.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
          ? Math.trunc(raw.timeoutMs)
          : DEFAULT_TIMEOUT_MS,
    });
  }
  return { servers, errors };
}
