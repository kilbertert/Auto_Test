#!/usr/bin/env tsx
// Planner orchestration (port of mattpocock/course-video-manager/.sandcastle/main.ts):
//
//   loop (max AFK_RALPH_ITERATIONS):
//     Plan      — a planner agent lists open `ready-for-agent` issues, builds a
//                 dependency graph, and emits <plan>{issues[]}</plan>
//     Execute   — each issue implemented + reviewed in its own docker worktree,
//                 up to AFK_RALPH_PARALLEL at once
//     Merge     — a merger agent merges the completed branches into main, runs
//                 the full check, pushes main, and closes the issues
//
// Unlike the single-issue runner (.sandcastle/main.ts), the merge phase is
// intentionally done inside the container (push main + close issues) — this is
// an explicit user-authorized override of the "host owns delivery" rule.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run, createSandbox, type RunResult } from "@ai-hero/sandcastle";
import { claudeProfile } from "./profile.js";

const MAX_ITERATIONS = Number(process.env.AFK_RALPH_ITERATIONS ?? 10);
const MAX_PARALLEL = Number(process.env.AFK_RALPH_PARALLEL ?? 4);
const INSTALL_CMD = process.env.AFK_INSTALL_CMD ?? "npm ci";
const PROFILE = process.env.AFK_PROFILE;

// --- testable pure helpers -------------------------------------------------

export function extractGhToken(hostsYaml: string): string | undefined {
  const m = hostsYaml.match(/oauth_token:\s*([^\s]+)/);
  return m?.[1];
}

export function parsePlanOutput(stdout: string): { number: number; title: string; branch: string }[] {
  const m = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!m) throw new Error("Planner did not produce a <plan> tag.\n\n" + stdout);
  const { issues } = JSON.parse(m[1]!) as {
    issues: { number: number; title: string; branch: string }[];
  };
  return Array.isArray(issues) ? issues : [];
}

// --- git helpers -----------------------------------------------------------

function currentBranch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
}

function ensureOnMain(): void {
  if (currentBranch() !== "main") {
    execSync("git checkout main", { stdio: "inherit" });
  }
  execSync("git fetch --prune origin", { stdio: "inherit" });
  execSync("git merge --ff-only origin/main", { stdio: "inherit" });
}

function profileConfig() {
  let token: string | undefined;
  try {
    token = extractGhToken(
      readFileSync(resolve(homedir(), ".config/gh/hosts.yml"), "utf8"),
    );
  } catch {
    /* no gh auth on host — planner/merge will fail with a clear gh error */
  }
  return claudeProfile(PROFILE, token ? { GH_TOKEN: token } : undefined);
}

// --- planner loop ----------------------------------------------------------

async function main(): Promise<void> {
  execSync("git fetch --prune origin", { stdio: "inherit" });

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    // Phase 1: Plan
    const plan = await run({
      ...profileConfig(),
      name: "Planner",
      promptFile: ".sandcastle/plan-prompt.md",
    });
    const issues = parsePlanOutput(plan.stdout);

    if (issues.length === 0) {
      console.log("No issues to work on. Exiting.");
      break;
    }
    console.log(`Planning complete. ${issues.length} issue(s) to work in parallel:`);
    for (const issue of issues) console.log(`  #${issue.number}: ${issue.title} → ${issue.branch}`);

    // Phase 2: Execute + Review (max MAX_PARALLEL in parallel)
    let running = 0;
    const queue: (() => void)[] = [];
    const acquire = () =>
      running < MAX_PARALLEL
        ? (running++, Promise.resolve())
        : new Promise<void>((resolveQueue) => queue.push(resolveQueue));
    const release = () => {
      running--;
      const next = queue.shift();
      if (next) {
        running++;
        next();
      }
    };

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        await acquire();
        try {
          const sandbox = await createSandbox({
            ...profileConfig(),
            branch: issue.branch,
            baseBranch: "origin/main",
            hooks: {
              host: {
                onSandboxReady: [{ command: INSTALL_CMD }],
              },
            },
          });
          try {
            const result = await sandbox.run({
              ...profileConfig(),
              name: `Implementer #${issue.number}`,
              promptFile: ".sandcastle/implement-prompt.md",
              promptArgs: {
                ISSUE_NUMBER: String(issue.number),
                ISSUE_TITLE: issue.title,
                BRANCH: issue.branch,
              },
              maxIterations: 3,
              completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
            });

            if (result.commits.length > 0) {
              await sandbox.run({
                ...profileConfig(),
                name: `Reviewer #${issue.number}`,
                promptFile: ".sandcastle/review-prompt.md",
                promptArgs: {
                  ISSUE_NUMBER: String(issue.number),
                  ISSUE_TITLE: issue.title,
                  BRANCH: issue.branch,
                },
                completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
              });
            }
            return result;
          } finally {
            await sandbox.close();
          }
        } finally {
          release();
        }
      }),
    );

    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(`  ✗ #${issues[i]!.number} (${issues[i]!.branch}) failed: ${outcome.reason}`);
      }
    }

    const completed = settled
      .map((outcome, i) => ({ outcome, issue: issues[i]! }))
      .filter(
        (
          entry,
        ): entry is {
          outcome: PromiseFulfilledResult<RunResult>;
          issue: { number: number; title: string; branch: string };
        } => entry.outcome.status === "fulfilled" && entry.outcome.value.commits.length > 0,
      );

    const completedBranches = completed.map((entry) => entry.issue.branch);
    console.log(`\nExecution complete. ${completedBranches.length} branch(es) with commits:`);
    for (const branch of completedBranches) console.log(`  ${branch}`);

    if (completedBranches.length === 0) {
      console.log("No commits produced. Nothing to merge.");
      continue;
    }

    // Phase 3: Merge — on main, in-container (user-authorized: push main + close issues)
    ensureOnMain();
    await run({
      ...profileConfig(),
      name: "Merger",
      maxIterations: 10,
      promptFile: ".sandcastle/merge-prompt.md",
      promptArgs: {
        BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        ISSUES: completed.map((entry) => `- #${entry.issue.number}: ${entry.issue.title}`).join("\n"),
      },
      completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
    });

    console.log("\nBranches merged.");
  }

  console.log("\nAll done.");
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
