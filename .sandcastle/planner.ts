#!/usr/bin/env tsx
// Planner orchestration (port of mattpocock/course-video-manager/.sandcastle/main.ts):
//
//   loop (max AFK_RALPH_ITERATIONS):
//     Plan      — a planner agent lists open `ready-for-agent` issues, builds a
//                 dependency graph, and emits <plan>{issues[]}</plan>
//     Execute   — each issue implemented + reviewed in its own docker worktree,
//                 up to AFK_RALPH_PARALLEL at once
//     Integrate — a merger agent merges the completed branches into one
//                 delivery branch, runs the full check, and the host opens a PR
import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run, createSandbox, type RunResult } from "@ai-hero/sandcastle";
import { claudeProfile } from "./profile.js";

// Wall-clock guardrail: some model providers stall mid-stream and never yield.
// Cap each agent run so a hung session aborts and is treated as an error the
// loop surfaces (BLOCKED) instead of hanging the whole planner forever.
// Tune per step via AFK_PLAN_TIMEOUT / AFK_RUN_TIMEOUT (seconds; 0 = no cap).
async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  if (!ms) return fn();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms / 1000}s wall-clock timeout (model stalled)`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const MAX_ITERATIONS = Number(process.env.AFK_RALPH_ITERATIONS ?? 10);
const MAX_PARALLEL = Number(process.env.AFK_RALPH_PARALLEL ?? 4);
const INSTALL_CMD = process.env.AFK_INSTALL_CMD ?? "npm ci";
const PROFILE = process.env.AFK_PROFILE;

// --- testable pure helpers -------------------------------------------------

export function parsePlanOutput(stdout: string): { number: number; title: string; branch: string }[] {
  const m = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!m) throw new Error("Planner did not produce a <plan> tag.\n\n" + stdout);
  const { issues } = JSON.parse(m[1]!) as {
    issues: { number: number; title: string; branch: string }[];
  };
  return Array.isArray(issues) ? issues : [];
}

export function extractClaimedIssues(bodies: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const body of bodies) {
    for (const match of body.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi)) {
      numbers.add(Number(match[1]));
    }
  }
  return numbers;
}

// --- git helpers -----------------------------------------------------------

function currentBranch(): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
}

function createDeliveryBranch(iteration: number): string {
  const branch = `agent/planner-${Date.now()}-${iteration}`;
  execSync("git fetch --prune origin", { stdio: "inherit" });
  execFileSync("git", ["checkout", "-b", branch, "origin/main"], { stdio: "inherit" });
  return branch;
}

function openPrIssueNumbers(): Set<number> {
  // ponytail: scans 100 open PRs; paginate if a repository can exceed that.
  const pullRequests = JSON.parse(
    execFileSync("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "body"], {
      encoding: "utf8",
    }),
  ) as { body: string | null }[];
  return extractClaimedIssues(pullRequests.map((pullRequest) => pullRequest.body ?? ""));
}

function profileConfig(includeGitHub = true) {
  let token: string | undefined;
  if (includeGitHub) {
    try {
      token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    } catch {
      /* planner commands will fail with a clear gh authentication error */
    }
  }
  return claudeProfile(PROFILE, token ? { GH_TOKEN: token } : undefined);
}

function openDeliveryPr(
  branch: string,
  issues: { number: number; title: string }[],
): string {
  if (currentBranch() !== branch) throw new Error(`Expected delivery branch ${branch}`);
  const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (status) throw new Error(`Delivery branch is not clean:\n${status}`);

  execFileSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
  const body = [
    "## Changes",
    "",
    ...issues.map((issue) => `- #${issue.number}: ${issue.title}`),
    "",
    "## Tests",
    "",
    "- Merge-phase project checks completed; repository CI remains required.",
    "",
    "## Checklist",
    "",
    "- [ ] Required CI passes",
    "- [ ] Review findings are triaged",
    "",
    ...issues.map((issue) => `Closes #${issue.number}`),
  ].join("\n");
  return execFileSync(
    "gh",
    ["pr", "create", "--base", "main", "--head", branch, "--title", "chore(afk): integrate planner batch", "--body", body],
    { encoding: "utf8" },
  ).trim();
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
    const claimedIssues = openPrIssueNumbers();
    const issues = parsePlanOutput(plan.stdout).filter((issue) => !claimedIssues.has(issue.number));

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
            const result = await withTimeout(
              Number(process.env.AFK_RUN_TIMEOUT ?? 3600) * 1000,
              `Implement #${issue.number}`,
              () => sandbox.run({
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
              }),
            );

            if (result.commits.length > 0) {
              await withTimeout(
                Number(process.env.AFK_RUN_TIMEOUT ?? 3600) * 1000,
                `Review #${issue.number}`,
                () => sandbox.run({
                  ...profileConfig(),
                  name: `Reviewer #${issue.number}`,
                  promptFile: ".sandcastle/review-prompt.md",
                  promptArgs: {
                    ISSUE_NUMBER: String(issue.number),
                    ISSUE_TITLE: issue.title,
                    BRANCH: issue.branch,
                  },
                  completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
                }),
              );
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

    // Phase 3: integrate locally, then let the host open the delivery PR.
    const deliveryBranch = createDeliveryBranch(iteration);
    const mergeResult = await withTimeout(
      Number(process.env.AFK_MERGE_TIMEOUT ?? 3600) * 1000,
      "Merge",
      () => run({
        ...profileConfig(false),
        name: "Merger",
        maxIterations: 10,
        promptFile: ".sandcastle/merge-prompt.md",
        promptArgs: {
          DELIVERY_BRANCH: deliveryBranch,
          BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        },
        completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
      }),
    );
    if (mergeResult.completionSignal !== "<promise>COMPLETE</promise>") {
      throw new Error("Merger did not complete; delivery branch was not pushed.");
    }

    const prUrl = openDeliveryPr(deliveryBranch, completed.map((entry) => entry.issue));
    console.log(`\nDelivery PR opened: ${prUrl}`);
    return;
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
