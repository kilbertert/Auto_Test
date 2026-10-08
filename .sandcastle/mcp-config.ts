/**
 * Which MCP servers the AFK sandbox gets, and the mounts that provide them.
 *
 * Kept in its own module — with **no import of the Sandcastle package** — so the
 * branching decision is runnable under plain `tsx`/`node` without the heavy
 * provider dependency. `profile.ts` consumes it; `mcp-config.check.ts` asserts it.
 *
 * The set is deliberately two servers, both read-only code intelligence:
 *
 *   - `serena` — LSP-backed symbol navigation. Baked into the image, so its
 *     config entry needs no mount; only the settings file below is a mount.
 *   - `codebase-memory-mcp` — the repository knowledge graph. A 258 MB *static*
 *     binary, mounted read-only from the host: mounting keeps every project's
 *     image from growing by a quarter of a gigabyte, and upgrading the tool
 *     takes effect on the next run with no image rebuild.
 *
 * What is deliberately NOT here, and why — because "add the MCPs" is exactly the
 * instruction that would get this wrong:
 *
 *   - `team-memory` holds other projects' memory. The sandbox runs
 *     candidate-controlled code against one repository; giving it a window into
 *     every other project is an access grant, not a convenience.
 *   - `google-scholar` needs a Serper API key, and nothing in an implementation
 *     task needs to search the open web. An implementation agent that can browse
 *     can also be talked into browsing.
 *
 * A server whose command is absent is OMITTED rather than declared: claude
 * silently skips a server it cannot start (verified — a session with a
 * nonexistent command still exits 0), so declaring a dead path degrades the
 * agent's tools with no signal anywhere. Omitting it does not make the failure
 * louder, but it does keep the config honest about what is actually provided —
 * and `mcp-config.check.ts` is what makes the omission visible.
 */
import { accessSync, constants, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Host path of the codebase-memory binary. Overridable for a different host. */
export function codebaseMemoryBinary(): string {
  return process.env.AFK_CODEBASE_MEMORY_BIN ?? join(homedir(), ".local/bin/codebase-memory-mcp");
}

/** In-sandbox path of the generated MCP config. Must match the Dockerfile wrapper. */
export const SANDBOX_MCP_CONFIG = "/home/agent/.afk-mcp.json";

/** In-sandbox path of the mounted codebase-memory binary. */
export const SANDBOX_CBM_BINARY = "/home/agent/.local/bin/codebase-memory-mcp";

function exists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `mcpServers` object written into the sandbox config.
 *
 * Exported so the check can assert the exact shape `mcpConfigMounts` is paired
 * with — asserting only the mounts would stay green if the two ever disagreed
 * about which server they describe.
 */
export function mcpServers(): Record<string, { command: string; args: string[] }> {
  const servers: Record<string, { command: string; args: string[] }> = {
    // Baked into the image at /usr/local/bin by the Dockerfile.
    serena: {
      command: "serena",
      args: ["start-mcp-server", "--context", "ide-assistant"],
    },
  };
  if (exists(codebaseMemoryBinary())) {
    servers["codebase-memory-mcp"] = {
      command: SANDBOX_CBM_BINARY,
      args: [],
    };
  }
  return servers;
}

/**
 * Mounts that make the MCP config usable inside the sandbox.
 *
 * Two files, one directory's worth of effect: the generated config itself, and
 * the codebase-memory binary it names. The serena binary needs no mount because
 * it is already in the image.
 */
export function mcpConfigMounts(): { hostPath: string; sandboxPath: string; readonly: boolean }[] {
  const mounts: { hostPath: string; sandboxPath: string; readonly: boolean }[] = [
    {
      hostPath: mcpConfigHostPath(),
      sandboxPath: SANDBOX_MCP_CONFIG,
      readonly: true,
    },
  ];
  if (exists(codebaseMemoryBinary())) {
    mounts.push({
      hostPath: codebaseMemoryBinary(),
      sandboxPath: SANDBOX_CBM_BINARY,
      readonly: true,
    });
  }
  return mounts;
}

/**
 * Host path of the config file `profile.ts` writes.
 *
 * Written per run rather than committed: the server set depends on what this
 * host actually has (a host without the codebase-memory binary gets one server,
 * not two), and a committed file would have to lie about that.
 */
export function mcpConfigHostPath(): string {
  return process.env.AFK_MCP_CONFIG ?? join(homedir(), ".afk-mcp.json");
}

/**
 * Write the config to `mcpConfigHostPath()` so the mount has something to mount.
 *
 * Called by `claudeProfile` before the sandbox is created. Idempotent: the file
 * is rewritten each run, which is what keeps it true to what this host has.
 * Written 0600 — it names local paths, not secrets, but it is per-run scratch,
 * not a shared artifact.
 */
export function writeMcpConfig(): string {
  const path = mcpConfigHostPath();
  writeFileSync(path, JSON.stringify({ mcpServers: mcpServers() }, null, 2) + "\n", { mode: 0o600 });
  return path;
}
