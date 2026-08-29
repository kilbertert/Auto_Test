import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AFK provider canary record", () => {
  it("records the official planning boundary and Sandcastle review without private inputs", async () => {
    const canary = await readFile("docs/afk-provider-canary.md", "utf8");

    expect(canary).toContain("/grill-with-docs");
    expect(canary).toContain("/to-spec");
    expect(canary).toContain("/to-tickets");
    expect(canary).toContain("Sandcastle");
    expect(canary).toMatch(/\b2026-\d{2}-\d{2}\b/);
    expect(canary).not.toMatch(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{10,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/);
    expect(canary).not.toMatch(/https?:\/\/[^\s`)]+/);
  });
});
