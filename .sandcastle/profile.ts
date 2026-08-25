import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeCode, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profiles = {
  claude: undefined,
  "claude-ark": process.env.AFK_CLAUDE_ARK_SETTINGS ?? "/home/claude/cliproxyapi/settings.ark.json",
  psydo: undefined,
  "aliyun-deepseek": undefined,
} as const;
const codexSettings = process.env.AFK_CODEX_SETTINGS ?? "/home/claude/.config/auto-test/codex.psydo.toml";
const psydoKey = process.env.AFK_PSYDO_KEY_FILE ?? "/home/claude/.config/aiops-diagnostics/keys/psydo-primary.key";
const aliyunSettings = process.env.AFK_ALIYUN_SETTINGS ?? "/home/claude/.config/auto-test/codex.aliyun-deepseek.toml";
const aliyunCsv = process.env.AFK_ALIYUN_CSV ?? "/home/claude/.config/auto-test/aliyun-deepseek.csv";

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
    "",
  ].join("\n");
  mkdirSync(dirname(aliyunSettings), { recursive: true, mode: 0o700 });
  writeFileSync(aliyunSettings, content, { mode: 0o600 });
}

export function claudeProfile(profile = process.env.AFK_PROFILE, env?: Record<string, string>) {
  if (profile && !(profile in profiles)) throw new Error("Unsupported profile; use claude, claude-ark, psydo, or aliyun-deepseek.");
  const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
  if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);
  const usePsydo = profile === "psydo";
  const useAliyun = profile === "aliyun-deepseek";
  const useCodex = usePsydo || useAliyun;
  const aliyun = useAliyun ? readAliyunCsv(aliyunCsv) : undefined;
  if (usePsydo && !existsSync(codexSettings)) throw new Error(`Codex settings not found: ${codexSettings}`);
  if (aliyun) ensureAliyunSettings(aliyun.baseUrl);

  return {
    agent: useCodex
      ? codex(process.env.AFK_MODEL ?? (useAliyun ? "deepseek-v4-pro-0813" : "gpt-5.6-sol"), { env: { CODEX_HOME: "/home/agent/.codex" } })
      : claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6", {
      env: profile ? { AFK_PROFILE: profile } : undefined,
    }),
    sandbox: docker({
      // Use the same image name that `npx sandcastle docker build-image`
      // produces (defaultImageName = sandcastle:<repo>). A hardcoded custom
      // name here means rebuilds target a different tag and the sandbox keeps
      // running a stale image — the cause of repeated false BLOCKEDs.
      imageName: process.env.AFK_IMAGE ?? "sandcastle:auto-test",
      env: {
        ...env,
        ...(usePsydo ? { OPENAI_API_KEY: readFileSync(psydoKey, "utf8").trim() } : {}),
        ...(aliyun ? { DASHSCOPE_API_KEY: aliyun.apiKey } : {}),
      },
      network: profile === "claude-ark" || useCodex ? "host" : undefined,
      mounts: useCodex
        ? [{ hostPath: useAliyun ? aliyunSettings : codexSettings, sandboxPath: "/home/agent/.codex/config.toml", readonly: true }]
        : settingsPath
          ? [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }]
          : undefined,
    }),
  };
}
