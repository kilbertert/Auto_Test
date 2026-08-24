import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.AFK_PROFILE;
const issue = process.argv.slice(2).find((arg, index) =>
  /^\d+$/.test(arg) && (profileIndex < 0 || index + 2 !== profileIndex + 1),
);
if (!issue || !/^\d+$/.test(issue)) {
  throw new Error("Usage: npm run afk -- [--profile claude|claude-ark] <issue-number>");
}

const root = resolve(import.meta.dirname, "..");
const branch = process.env.AFK_BRANCH ?? `agent/issue-${issue}`;
const profiles = {
  claude: undefined,
  "claude-ark": process.env.AFK_CLAUDE_ARK_SETTINGS ?? "/home/claude/cliproxyapi/settings.ark.json",
} as const;
if (profile && !(profile in profiles)) throw new Error("Unsupported profile; use claude or claude-ark.");
const settingsPath = profile ? profiles[profile as keyof typeof profiles] : undefined;
if (settingsPath && !existsSync(settingsPath)) throw new Error(`Profile settings not found: ${settingsPath}`);
const envFile = resolve(root, ".sandcastle/.env");
if (!existsSync(envFile) && !profile) {
  throw new Error("Missing .sandcastle/.env; select an existing profile or configure an explicit credential.");
}

const result = await run({
  cwd: root,
  name: `auto-test-issue-${issue}`,
  agent: claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6", {
    env: profile ? { AFK_PROFILE: profile } : undefined,
  }),
  sandbox: docker({
    imageName: process.env.AFK_IMAGE ?? "auto-test-sandcastle:local",
    network: profile === "claude-ark" ? "host" : undefined,
    mounts: settingsPath ? [{ hostPath: settingsPath, sandboxPath: "/run/afk/profile-settings.json", readonly: true }] : undefined,
  }),
  branchStrategy: { type: "branch", branch },
  promptFile: ".sandcastle/implement.md",
  promptArgs: { ISSUE_NUMBER: issue, ISSUE_TITLE: process.env.AFK_TITLE ?? "specified issue" },
  copyToWorktree: existsSync(envFile) ? [".sandcastle/.env"] : [],
  maxIterations: Number(process.env.AFK_ITERATIONS ?? 3),
  completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
  logging: { type: "file", path: `.sandcastle/logs/issue-${issue}.log` },
});

console.log(JSON.stringify({ issue, branch, commits: result.commits, completionSignal: result.completionSignal }, null, 2));
