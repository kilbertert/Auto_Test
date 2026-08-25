import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AFK runner", () => {
  it("keeps delivery on the host and requires deterministic checks", async () => {
    const prompt = await readFile(".sandcastle/implement.md", "utf8");
    const runner = await readFile(".sandcastle/main.ts", "utf8");

    expect(prompt).toContain("npm run check");
    expect(prompt).toContain("Do not merge, push, close issues");
    expect(runner).toContain('branchStrategy: { type: "branch", branch }');
    expect(runner).toContain('maxIterations: Number(process.env.AFK_ITERATIONS ?? 3)');
    expect(runner).toContain('claude|claude-ark|psydo|aliyun-deepseek');
  });

  it("keeps the copied PRD workflow wired to native sub-issues and server profiles", async () => {
    const prdSkill = await readFile(".claude/skills/to-prd-project/SKILL.md", "utf8");
    const issueSkill = await readFile(".claude/skills/to-issues-project/SKILL.md", "utf8");
    const runner = await readFile(".sandcastle/to-issues-prd/to-issues-prd.ts", "utf8");

    expect(prdSkill).toContain("kilbertert/Auto_Test");
    expect(issueSkill).toContain("sub_issues");
    expect(runner).toContain('from "../profile.js"');
    expect(runner).toContain("/sub_issues");
  });
});
