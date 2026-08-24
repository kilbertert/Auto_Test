import * as sandcastle from "@ai-hero/sandcastle";
import { claudeProfile } from "../profile.js";
import * as path from "node:path";

const PRD_NUMBER = required("PRD_NUMBER");
const PRD_TITLE = required("PRD_TITLE");
const SUB_ISSUE_NUMBER = required("SUB_ISSUE_NUMBER");
const SUB_ISSUE_TITLE = required("SUB_ISSUE_TITLE");
const BRANCH = required("BRANCH");

const result = await sandcastle.run({
  name: `implement-prd-#${PRD_NUMBER}-sub-#${SUB_ISSUE_NUMBER}`,
  ...claudeProfile(),
  logging: { type: "stdout" },
  promptFile: path.join(import.meta.dirname, "prompt.md"),
  promptArgs: {
    PRD_NUMBER,
    PRD_TITLE,
    SUB_ISSUE_NUMBER,
    SUB_ISSUE_TITLE,
    BRANCH,
  },
});

// No "did this produce commits?" check: a sub-issue's work may already have
// been completed by a previous iteration, in which case the agent legitimately
// produces zero new commits and we still want the workflow to proceed (close
// the sub-issue, advance to the next one).

console.log(`\nImplementation finished for sub-issue #${SUB_ISSUE_NUMBER}.`);
console.log(`  commits this run: ${result.commits.length}`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}
