import { existsSync, readFileSync } from "node:fs";
import { claudeCode, codex } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profiles = {
  claude: undefined,
  "claude-ark": process.env.AFK_CLAUDE_ARK_SETTINGS ?? "/home/claude/cliproxyapi/settings.ark.json",
  psydo: undefined,
} as const;
const codexSettings = process.env.AFK_CODEX_SETTINGS ?? "/home/claude/.config/auto-test/codex.psydo.toml";
const psydoKey = process.env.AFK_PSYDO_KEY_FILE ?? "/home/claude/.config/aiops-diagnostics/keys/psydo-primary.key";

export function claudeProfile(profile = process.env.AFK_PROFILE, env?: Record<string, string>) {
  if (profile && !(profile in profiles)) throw new Error("Unsupported profile; use claude, claude-ark, or psydo.");
  const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
  if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);
  if (profile === "psydo" && !existsSync(codexSettings)) throw new Error(`Codex settings not found: ${codexSettings}`);
  const useCodex = profile === "psydo";

  return {
    agent: useCodex
      ? codex(process.env.AFK_MODEL ?? "gpt-5.6-sol", { env: { CODEX_HOME: "/home/agent/.codex" } })
      : claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6", {
      env: profile ? { AFK_PROFILE: profile } : undefined,
    }),
    sandbox: docker({
      imageName: process.env.AFK_IMAGE ?? "auto-test-sandcastle:local",
      env,
      network: profile === "claude-ark" || useCodex ? "host" : undefined,
      env: useCodex ? { OPENAI_API_KEY: readFileSync(psydoKey, "utf8").trim() } : undefined,
      mounts: useCodex
        ? [{ hostPath: codexSettings, sandboxPath: "/home/agent/.codex/config.toml", readonly: true }]
        : settingsPath
          ? [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }]
          : undefined,
    }),
  };
}
