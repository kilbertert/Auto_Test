import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AFK runner", () => {
  it("keeps delivery on the host and requires deterministic checks", async () => {
    const prompt = await readFile(".sandcastle/implement.md", "utf8");
    const runner = await readFile(".sandcastle/main.ts", "utf8");

    expect(prompt).toContain("npm run check");
    expect(prompt).toContain("Do not merge, push, close issues");
    expect(runner).toContain('branchStrategy: { type: "branch", branch, baseBranch: "origin/main" }');
    expect(runner).toContain('maxIterations: Number(process.env.AFK_ITERATIONS ?? 3)');
    expect(runner).toContain('claude|claude-ark|agentrouter|psydo|aliyun-deepseek');
  });

  it("keeps official planning skills as the only planning entry", async () => {
    const tracker = await readFile("docs/agents/issue-tracker.md", "utf8");
    const domain = await readFile("docs/agents/domain.md", "utf8");
    const workflow = await readFile("docs/afk-workflow.md", "utf8");

    expect(tracker).toContain("GitHub");
    expect(domain).toContain("CONTEXT.md");
    expect(workflow).toContain("/to-spec");
    expect(workflow).toContain("/to-tickets");
    await expect(access(".sandcastle/to-issues-prd/to-issues-prd.ts")).rejects.toThrow();
    await expect(access(".claude/skills/to-prd-project/SKILL.md")).rejects.toThrow();
  });
});
