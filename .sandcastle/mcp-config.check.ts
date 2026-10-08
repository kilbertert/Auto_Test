/**
 * Runnable regression check for the sandbox MCP config.
 *
 * Run: `npx tsx .sandcastle/mcp-config.check.ts`
 *
 * Asserts the properties that decide what the agent can reach — the ones whose
 * failure is silent:
 *
 *   - a server whose command is missing is OMITTED, never declared dead;
 *   - the mounts and the server list name the same set (asserting either alone
 *     stays green while the two drift apart);
 *   - the config the mount points at is the config the writer produces, at the
 *     path the Dockerfile wrapper reads.
 *
 * Without this, removing the codebase-memory binary would quietly halve the
 * agent's tools and nothing would fail.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  SANDBOX_CBM_BINARY,
  SANDBOX_MCP_CONFIG,
  mcpConfigHostPath,
  mcpConfigMounts,
  mcpServers,
  writeMcpConfig,
} from "./mcp-config.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`mcp-config check failed: ${message}`);
}

// --- the sandbox paths are the ones the images actually use -------------------
//
// The Dockerfile wrapper hardcodes `/home/agent/.afk-mcp.json`. A rename on
// either side would leave claude reading a file that is not there, and claude
// treats a missing --mcp-config as "no servers" rather than an error.
//
// The project's own Dockerfile, which bootstrap rendered from
// `templates/Dockerfile.<language>` — one file, already specialised to this
// repo's language, so there is no language loop here.
//
// Reading the template instead would break in exactly the projects this check
// exists to guard: bootstrap copies the rendered Dockerfile into
// `.sandcastle/` and never copies `templates/`, so `../../templates/...`
// resolves outside the repository and the check dies with ENOENT — a red CI job
// in every scaffolded project, for a file the project does not have.
const dockerfilePath = new URL("./Dockerfile", import.meta.url);
if (!existsSync(dockerfilePath)) {
  console.error(
    ".sandcastle/Dockerfile is missing — bootstrap renders it from templates/; " +
      "a project without it has not been scaffolded correctly",
  );
  process.exit(1);
}
const dockerfile = readFileSync(dockerfilePath, "utf8");
assert(
  dockerfile.includes(`--mcp-config ${SANDBOX_MCP_CONFIG}`),
  `.sandcastle/Dockerfile must pass --mcp-config ${SANDBOX_MCP_CONFIG}`,
);
assert(
  dockerfile.includes("serena-agent"),
  ".sandcastle/Dockerfile must install serena — the config names it and nothing else provides it",
);
assert(
  dockerfile.includes("UV_TOOL_BIN_DIR=/usr/local/bin"),
  ".sandcastle/Dockerfile: serena must land on the PATH every user resolves, not in root's home",
);

// --- the server set ----------------------------------------------------------
const servers = mcpServers();
assert("serena" in servers, "serena must always be present — it is in the image");
assert(
  servers.serena.command === "serena",
  "serena must be invoked by name: the image puts it on the PATH",
);

// The forbidden pair. These are the servers that would widen what the sandbox
// can reach; naming them here makes an accidental addition fail loudly.
for (const forbidden of ["team-memory", "google-scholar"]) {
  assert(
    !(forbidden in servers),
    `${forbidden} must NOT be given to the sandbox — see the rationale in mcp-config.ts`,
  );
}

// --- mounts and servers describe the same set -------------------------------
const mounts = mcpConfigMounts();
const configMount = mounts.find((m) => m.sandboxPath === SANDBOX_MCP_CONFIG);
assert(configMount !== undefined, "the MCP config itself must be mounted");
assert(configMount.readonly, "the MCP config mount must be read-only");

const hasCbm = "codebase-memory-mcp" in servers;
const cbmMount = mounts.find((m) => m.sandboxPath === SANDBOX_CBM_BINARY);
assert(
  hasCbm === (cbmMount !== undefined),
  "the codebase-memory server and its mount must appear together — one without the other is a server that cannot start",
);
if (cbmMount) {
  assert(cbmMount.readonly, "the codebase-memory binary mount must be read-only");
}

// Every non-baked server must have a mount; every mount must have a server.
// (serena is baked into the image, so it is the one server with no mount.)
const mountedBinaries = mounts
  .filter((m) => m.sandboxPath !== SANDBOX_MCP_CONFIG)
  .map((m) => m.sandboxPath);
for (const [name, server] of Object.entries(servers)) {
  if (server.command.startsWith("/")) {
    assert(
      mountedBinaries.includes(server.command),
      `${name} names ${server.command}, which is not mounted — it would fail to start`,
    );
  }
}
for (const path of mountedBinaries) {
  assert(
    Object.values(servers).some((s) => s.command === path),
    `mounted ${path} but no server names it — a mount nothing reads`,
  );
}

// --- the written config is what the mount will expose ------------------------
const written = writeMcpConfig();
assert(
  written === mcpConfigHostPath(),
  "writeMcpConfig must write to the path the mount reads",
);
const onDisk = JSON.parse(readFileSync(written, "utf8"));
assert(
  JSON.stringify(onDisk.mcpServers) === JSON.stringify(servers),
  "the file on disk must match mcpServers()",
);

console.log(`mcp-config check ok (${Object.keys(servers).length} servers, ${mounts.length} mounts)`);
