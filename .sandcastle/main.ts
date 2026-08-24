import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const issue = process.argv[2];
if (!issue || !/^\d+$/.test(issue)) {
  throw new Error("Usage: npm run afk -- <issue-number>");
}

const root = resolve(import.meta.dirname, "..");
const branch = process.env.AFK_BRANCH ?? `agent/issue-${issue}`;
const envFile = resolve(root, ".sandcastle/.env");
if (!existsSync(envFile)) {
  throw new Error("Missing .sandcastle/.env; copy .env.example and configure an agent credential.");
}

const result = await run({
  cwd: root,
  name: `auto-test-issue-${issue}`,
  agent: claudeCode(process.env.AFK_MODEL ?? "claude-sonnet-4-6"),
  sandbox: docker({ imageName: process.env.AFK_IMAGE ?? "auto-test-sandcastle:local" }),
  branchStrategy: { type: "branch", branch },
  promptFile: ".sandcastle/implement.md",
  promptArgs: { ISSUE_NUMBER: issue, ISSUE_TITLE: process.env.AFK_TITLE ?? "specified issue" },
  copyToWorktree: [".sandcastle/.env"],
  maxIterations: Number(process.env.AFK_ITERATIONS ?? 3),
  completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
  logging: { type: "file", path: `.sandcastle/logs/issue-${issue}.log` },
});

console.log(JSON.stringify({ issue, branch, commits: result.commits, completionSignal: result.completionSignal }, null, 2));
