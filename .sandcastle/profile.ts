import { existsSync } from "node:fs";
import { claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profiles = {
  claude: undefined,
  "claude-ark": process.env.AFK_CLAUDE_ARK_SETTINGS ?? "/home/claude/cliproxyapi/settings.ark.json",
} as const;

export function claudeProfile(profile = process.env.AFK_PROFILE, env?: Record<string, string>) {
  if (profile && !(profile in profiles)) throw new Error("Unsupported profile; use claude or claude-ark.");
  const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
  if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);

  return {
    agent: claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6", {
      env: profile ? { AFK_PROFILE: profile } : undefined,
    }),
    sandbox: docker({
      imageName: process.env.AFK_IMAGE ?? "auto-test-sandcastle:local",
      env,
      network: profile === "claude-ark" ? "host" : undefined,
      mounts: settingsPath
        ? [{ hostPath: settingsPath, sandboxPath: "/home/agent/.afk-profile-settings.json", readonly: true }]
        : undefined,
    }),
  };
}
