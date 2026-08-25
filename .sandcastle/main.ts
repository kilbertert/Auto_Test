import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "@ai-hero/sandcastle";
import { claudeProfile } from "./profile.js";

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.AFK_PROFILE;
const issue = process.argv.slice(2).find((arg, index) =>
  /^\d+$/.test(arg) && (profileIndex < 0 || index + 2 !== profileIndex + 1),
);
if (!issue || !/^\d+$/.test(issue)) {
  throw new Error("Usage: npm run afk -- [--profile claude|claude-ark|psydo|aliyun-deepseek] <issue-number>");
}

const root = resolve(import.meta.dirname, "..");
const branch = process.env.AFK_BRANCH ?? `agent/issue-${issue}`;
const envFile = resolve(root, ".sandcastle/.env");
if (!existsSync(envFile) && !profile) {
  throw new Error("Missing .sandcastle/.env; select an existing profile or configure an explicit credential.");
}

const result = await run({
  cwd: root,
  name: `auto-test-issue-${issue}`,
  ...claudeProfile(profile),
  branchStrategy: { type: "branch", branch },
  promptFile: ".sandcastle/implement.md",
  promptArgs: { ISSUE_NUMBER: issue, ISSUE_TITLE: process.env.AFK_TITLE ?? "specified issue" },
  copyToWorktree: existsSync(envFile) ? [".sandcastle/.env"] : [],
  maxIterations: Number(process.env.AFK_ITERATIONS ?? 3),
  completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
  logging: { type: "file", path: `.sandcastle/logs/issue-${issue}.log` },
});

console.log(JSON.stringify({ issue, branch, commits: result.commits, completionSignal: result.completionSignal }, null, 2));
