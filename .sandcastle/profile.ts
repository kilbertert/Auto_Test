import { claudeCode, type AgentProvider, type SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profiles = {
  claude: undefined,
  // Endpoint is baked into the image at build time (see .sandcastle/Dockerfile),
  // so there is no host settings file to mount and no AFK_*_SETTINGS override.
  "claude-stepfun": undefined,
} as const;

export function claudeProfile(
  profile = process.env.AFK_PROFILE,
  env?: Record<string, string>,
): { agent: AgentProvider; sandbox: SandboxProvider } {
  if (profile && !(profile in profiles)) {
    throw new Error(`Unsupported profile; use ${Object.keys(profiles).join(", ")}.`);
  }
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
    }),
  };
}
