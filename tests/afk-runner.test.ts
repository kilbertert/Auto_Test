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
  });
});
