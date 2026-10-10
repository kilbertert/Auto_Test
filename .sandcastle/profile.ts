import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeCode,
  type AgentProvider,
  type SandboxHooks,
  type SandboxProvider,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { sandboxNetworkOptions } from "./profile-network.js";

/** The prepare script, relative to the repository root. */
const PREPARE_SCRIPT = join(".sandcastle", "sandbox-prepare.sh");
import {
  SANDBOX_CBM_BINARY,
  codebaseMemoryAvailable,
  mcpConfigMounts,
  writeMcpConfig,
} from "./mcp-config.js";

// Endpoints are supplied as host settings files mounted read-only into the
// sandbox, never baked into the image. A baked key lands in an image layer
// that anyone who can pull the image can read, and rotating it means rebuilding
// with --no-cache because a secret mount does not invalidate the layer cache.
// A mount leaves the key on the host, where rotating it is an edit.
const profiles = {
  claude: undefined,
  // Local relay (cli-proxy-api on 127.0.0.1:8317), reached with a host-network
  // sandbox. The settings file points ANTHROPIC_BASE_URL at the relay loopback
  // address, so the container MUST share the host network namespace —
  // a default-bridge container cannot reach the host 127.0.0.1 (measured).
  "claude-deepseek": process.env.AFK_DEEPSEEK_SETTINGS ?? join(homedir(), "cliproxyapi/settings.deepseek.json"),
} as const;

export function claudeProfile(
  profile = process.env.AFK_PROFILE,
  env?: Record<string, string>,
): { agent: AgentProvider; sandbox: SandboxProvider; hooks: SandboxHooks } {
  // Materialise the MCP config before the sandbox is created — the mount below
  // needs a file to point at, and writing it per run is what keeps it true to
  // what this host actually has.
  writeMcpConfig();
  if (profile && !(profile in profiles)) {
    throw new Error(`Unsupported profile; use ${Object.keys(profiles).join(", ")}.`);
  }
  const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
  if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);
  const safeEnv = { ...(env ?? {}) };
  const explicitAgentToken = safeEnv.AFK_AGENT_GH_TOKEN;
  delete safeEnv.GH_TOKEN;
  delete safeEnv.AFK_AGENT_GH_TOKEN;
  const agentToken = process.env.AFK_AGENT_GH_TOKEN ?? explicitAgentToken;

  return {
    // `hooks` is an option of `run()`, NOT of the sandbox provider. It lived
    // inside `docker()` where the option is not read at all — no error, no
    // warning, no hook. A hook that never runs is indistinguishable from one
    // that ran and did nothing.
    hooks: {
      sandbox: {
        onSandboxReady: [
          ...(existsSync(join(process.cwd(), PREPARE_SCRIPT))
            ? [
                {
                  command: "bash .sandcastle/sandbox-prepare.sh",
                  timeoutMs: Number(process.env.AFK_PREPARE_TIMEOUT_MS ?? 15 * 60 * 1000),
                },
              ]
            : []),
          // The knowledge-graph server holds no data until the repository is
          // indexed, so its tools answer an empty graph on the first call and
          // the agent concludes they are useless.
          ...(codebaseMemoryAvailable()
            ? [
                {
                  command: `timeout 120 ${SANDBOX_CBM_BINARY} cli index_repository --repo-path . --mode fast || true`,
                  timeoutMs: Number(process.env.AFK_INDEX_TIMEOUT_MS ?? 5 * 60 * 1000),
                },
              ]
            : []),
        ],
      },
    },
    agent: claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6"),
    sandbox: docker({
      // Use the same image name that `npx sandcastle docker build-image`
      // produces (defaultImageName = sandcastle:<repo>). A hardcoded custom
      // name here means rebuilds target a different tag and the sandbox keeps
      // running a stale image — the cause of repeated false BLOCKEDs.
      imageName: process.env.AFK_IMAGE ?? "sandcastle:auto-test-governance",
      env: {
        ...safeEnv,
        // AFK_PROFILE lives in the sandbox env (not the agent env) so that
        // both run() and createSandbox() containers see it — createSandbox
        // does not re-inject agent env into an already-started container, and
        // the Dockerfile claude wrapper dispatches on it.
        ...(profile ? { AFK_PROFILE: profile } : {}),
        ...(agentToken ? { GH_TOKEN: agentToken } : {}),
      },
      // Host networking is required only by profiles whose endpoint is the
      // host-loopback relay: a default-bridge container cannot reach the host's
      // 127.0.0.1. Every other profile talks to a public HTTPS origin and stays
      // on the default bridge. The options come from `profile-network.ts` so
      // `profile-network.check.ts` asserts the exact object this call splats —
      // the helper's return value alone would leave a broken wiring green.
      // The project's own sandbox preparation, run once per iteration after the
      // container is up and before the agent starts.
      //
      // A run's workspace starts empty, so without this the agent installs its own
      // dependencies — and an agent that sees "not installed" cannot tell *this
      // checkout was never set up* from *this sandbox lacks the prerequisite*, so
      // it downloads one. Keep this in the environment, not in the agent's
      // instructions: what a run needs before it starts is not something to
      // re-derive by probing.
      //
      // Optional by construction — no file, no hook, no cost.
      ...sandboxNetworkOptions(profile),
      // The mounts are unconditional. The MCP pair is independent of the
      // endpoint: the graph is mounted from the host and serena is in the image,
      // both regardless of how the agent authenticates. Gating them on
      // settingsPath (as this started out) made the setting a proxy for
      // "is this a non-default profile" — and the claude profile is the one
      // that resolves no settings file, so the default profile was exactly the
      // one that got no mounts, no config file, and therefore no servers. The
      // wrapper arm also passes no --mcp-config, so nothing else
      // supplied them: not a wrong path, just absent.
      mounts: [
        // Present only when the profile resolves an endpoint, because without
        // one there is no file to mount — the wrapper claude arm uses the
        // Anthropic default and reads no settings.
        ...(settingsPath
          ? [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }]
          : []),
        ...mcpConfigMounts(),
      ],
    }),
  };
}
