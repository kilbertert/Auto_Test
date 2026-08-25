import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import * as sandcastle from "@ai-hero/sandcastle";
import { claudeProfile } from "../profile.js";
import { runWithRetry } from "../run-with-retry";

const ISSUE_NUMBER = required("ISSUE_NUMBER");
const ISSUE_TITLE = required("ISSUE_TITLE");
const BRANCH = required("BRANCH");
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp";

const PromptOutput = z.object({
  prTitle: z.string().min(1).max(256),
  prDescription: z.string().min(1),
});

const result = await runWithRetry({
  name: `write-pr-#${ISSUE_NUMBER}`,
  ...claudeProfile(process.env.AFK_PROFILE),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    BRANCH,
  },
  output: sandcastle.Output.object({
    tag: "output",
    schema: PromptOutput,
  }),
});

fs.writeFileSync(path.join(OUTPUT_DIR, "pr_title.txt"), result.output.prTitle);
fs.writeFileSync(
  path.join(OUTPUT_DIR, "pr_description.txt"),
  result.output.prDescription
);

console.log(`\nWrote PR metadata to ${OUTPUT_DIR}`);
console.log(`  title: ${result.output.prTitle}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
