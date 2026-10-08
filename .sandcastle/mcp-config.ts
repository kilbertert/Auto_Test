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
import { accessSync, constants, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Host path of the codebase-memory binary. Overridable for a different host. */
export function codebaseMemoryBinary(): string {
  return process.env.AFK_CODEBASE_MEMORY_BIN ?? join(homedir(), ".local/bin/codebase-memory-mcp");
}

/** In-sandbox path of the generated MCP config. Must match the Dockerfile wrapper. */
export const SANDBOX_MCP_CONFIG = "/home/agent/.afk-mcp.json";

/** In-sandbox path of the mounted codebase-memory binary. */
export const SANDBOX_CBM_BINARY = "/home/agent/.local/bin/codebase-memory-mcp";

// `isFile()` and `X_OK`, not `R_OK`: this decides whether claude is handed a
// *command*, and a readable file is not one. A path that exists but cannot be
// executed — a 0644 copy, a directory, a dangling symlink — would be declared to
// claude, mounted, and then fail to start. Claude skips a server whose command it
// cannot launch without reporting anything, so the result is a silent loss of
// half the agent's tools rather than an error. (Verified: an empty `mcpServers`
// and a session with an unreachable command both exit 0.)
function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Exported for the check: one predicate decides both the server and its mount. */
export function codebaseMemoryAvailable(): boolean {
  const bin = codebaseMemoryBinary();
  return isExecutable(bin) && canExecute(bin);
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
  if (codebaseMemoryAvailable()) {
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
  if (codebaseMemoryAvailable()) {
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
 * Called by `claudeProfile` before the sandbox is created. The file is rewritten
 * each run, which is what keeps it true to what this host has.
 *
 * Written by rename, never in place. The path is a single shared file while the
 * planner starts several implementations at once, and it is bind-mounted into
 * each of them: a truncate-then-write leaves a window in which a sandbox that is
 * already starting reads a partial file and comes up with fewer servers, or none.
 * `rename(2)` is atomic within a filesystem, so a reader sees either the old
 * complete file or the new one. The temp lives in the same directory for the
 * same reason — across devices the rename is a copy, and the window returns.
 *
 * Mode 0600 and a 0700 parent: it names local paths, not secrets, but a process
 * other than this user has no business reading which tools the agent runs.
 *
 * The uid caveat, recorded because it is real: the bind mount carries ownership,
 * so a sandbox whose agent uid differs from this process's uid cannot read a 0600
 * file. That holds on this host only by construction — the runner builds each
 * image with `--build-arg AGENT_UID="$(id -u)"`, so the agent uid is the runner's
 * — and a project that builds its image elsewhere has to match them.
 */
export function writeMcpConfig(): string {
  const path = mcpConfigHostPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mcpServers: mcpServers() }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
