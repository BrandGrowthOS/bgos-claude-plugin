/**
 * What the MCP server declares as its own name and version at initialize. The version is the one
 * package.json holds (lib/version-heartbeat.ts readOwnVersion, the source the heartbeat uses); the
 * literal 0.19.0 it replaced was never moved (HOAI board row 81a68f4). Null (an unreadable
 * package.json) declares 0.0.0, as the heartbeat's capability call does.
 */
export function mcpServerInfo(version: string | null): { name: string; version: string } {
  return { name: 'bgos', version: version ?? '0.0.0' }
}
