import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCode, codex, type AgentProvider, type SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profiles = {
  claude: undefined,
  "claude-ark": process.env.AFK_CLAUDE_ARK_SETTINGS ?? join(homedir(), "cliproxyapi/settings.ark.json"),
  agentrouter: process.env.AFK_AGENTROUTER_SETTINGS ?? join(homedir(), "cliproxyapi/settings.airouter2.json"),
  psydo: undefined,
  "aliyun-deepseek": undefined,
} as const;
const configDir = process.env.AFK_CONFIG_DIR ?? join(homedir(), ".config/afk");
const legacyConfigDir = join(homedir(), ".config/auto-test");
const firstExisting = (...paths: string[]): string => paths.find(existsSync) ?? paths[0]!;
const codexSettings = process.env.AFK_CODEX_SETTINGS ?? firstExisting(
  join(configDir, "codex.psydo.toml"),
  join(legacyConfigDir, "codex.psydo.toml"),
);
const psydoKey = process.env.AFK_PSYDO_KEY_FILE ?? firstExisting(
  join(configDir, "psydo-primary.key"),
  join(homedir(), ".config/aiops-diagnostics/keys/psydo-primary.key"),
);
const aliyunSettings = process.env.AFK_ALIYUN_SETTINGS ?? firstExisting(
  join(configDir, "codex.aliyun-deepseek.toml"),
  join(legacyConfigDir, "codex.aliyun-deepseek.toml"),
);
const aliyunCsv = process.env.AFK_ALIYUN_CSV ?? firstExisting(
  join(configDir, "aliyun-deepseek.csv"),
  join(legacyConfigDir, "aliyun-deepseek.csv"),
);

function readAliyunCsv(path: string): { apiKey: string; baseUrl: string } {
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const separator = line.indexOf(",");
    if (separator < 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const apiKey = values.get("apiKey");
  const baseUrl = values.get("openAiCompatible");
  if (!apiKey || !baseUrl) throw new Error("Aliyun CSV must contain apiKey and openAiCompatible");
  try {
    if (new URL(baseUrl).protocol !== "https:") throw new Error();
  } catch {
    throw new Error("Aliyun openAiCompatible must be an HTTPS URL");
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

function ensureAliyunSettings(baseUrl: string): void {
  const content = [
    'model = "deepseek-v4-pro-0813"',
    'model_provider = "aliyun-deepseek"',
    'model_reasoning_effort = "high"',
    'model_context_window = 1000000',
    "",
    "[model_providers.aliyun-deepseek]",
    'name = "Alibaba Cloud DeepSeek V4 Pro"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "DASHSCOPE_API_KEY"',
    "requires_openai_auth = false",
    // Model-stability guardrail: bound slow/hung upstream responses so a
    // stalled codex request fails fast instead of hanging the whole session.
    // request_timeout (s) caps a single upstream request; request_max_retries
    // limits re-attempts. Tune via AFK_REQUEST_TIMEOUT / AFK_REQUEST_RETRIES.
    `request_timeout = ${process.env.AFK_REQUEST_TIMEOUT ?? 120}`,
    `request_max_retries = ${process.env.AFK_REQUEST_RETRIES ?? 2}`,
    "",
  ].join("\n");
  mkdirSync(dirname(aliyunSettings), { recursive: true, mode: 0o700 });
  writeFileSync(aliyunSettings, content, { mode: 0o600 });
}

export function claudeProfile(
  profile = process.env.AFK_PROFILE,
  env?: Record<string, string>,
): { agent: AgentProvider; sandbox: SandboxProvider } {
  if (profile && !(profile in profiles)) throw new Error("Unsupported profile; use claude, claude-ark, agentrouter, psydo, or aliyun-deepseek.");
  const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
  if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);
  const usePsydo = profile === "psydo";
  const useAliyun = profile === "aliyun-deepseek";
  const useCodex = usePsydo || useAliyun;
  const aliyun = useAliyun ? readAliyunCsv(aliyunCsv) : undefined;
  if (usePsydo && !existsSync(codexSettings)) throw new Error(`Codex settings not found: ${codexSettings}`);
  if (aliyun) ensureAliyunSettings(aliyun.baseUrl);
  const safeEnv = { ...(env ?? {}) };
  const explicitAgentToken = safeEnv.AFK_AGENT_GH_TOKEN;
  delete safeEnv.GH_TOKEN;
  delete safeEnv.AFK_AGENT_GH_TOKEN;
  const agentToken = process.env.AFK_AGENT_GH_TOKEN ?? explicitAgentToken;

  return {
    agent: useCodex
      ? codex(process.env.AFK_MODEL ?? (useAliyun ? "deepseek-v4-pro-0813" : "gpt-5.6-sol"), { env: { CODEX_HOME: "/home/agent/.codex" } })
      : claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6"),
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
        ...(usePsydo ? { OPENAI_API_KEY: readFileSync(psydoKey, "utf8").trim() } : {}),
        ...(aliyun ? { DASHSCOPE_API_KEY: aliyun.apiKey } : {}),
      },
      ...(profile === "claude-ark" || useCodex ? { network: "host" as const } : {}),
      ...(useCodex
        ? { mounts: [{ hostPath: useAliyun ? aliyunSettings : codexSettings, sandboxPath: "/home/agent/.codex/config.toml", readonly: true }] }
        : settingsPath
          ? { mounts: [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }] }
          : {}),
    }),
  };
}
