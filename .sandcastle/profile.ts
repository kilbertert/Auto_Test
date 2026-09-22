import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeCode, type AgentProvider, type SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// Endpoints are supplied as host settings files mounted read-only into the
// sandbox, never baked into the image. A baked key lands in an image layer
// that anyone who can pull the image can read, and rotating it means rebuilding
// with --no-cache because a secret mount does not invalidate the layer cache.
// A mount leaves the key on the host, where rotating it is an edit.
const profiles = {
  claude: undefined,
  "claude-stepfun": process.env.AFK_STEPFUN_SETTINGS ?? join(homedir(), "cliproxyapi/settings.stepfun.json"),
} as const;

export function claudeProfile(
  profile = process.env.AFK_PROFILE,
  env?: Record<string, string>,
): { agent: AgentProvider; sandbox: SandboxProvider } {
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
      // Every remaining profile reaches a public HTTPS origin over the default
      // bridge. Host networking existed for a relay bound to the host loopback,
      // which a sandbox cannot reach; no current profile has that dependency.
      ...(settingsPath
        ? { mounts: [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }] }
        : {}),
    }),
  };
}
