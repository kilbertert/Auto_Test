#!/usr/bin/env node
/**
 * Assert `.sandcastle/REPO-MAP.md` exists and matches what the generator produces.
 *
 * A stale map is worse than a missing one: the agent reads it with the same
 * confidence as the code, and it silently points at files that moved. This is
 * what makes the staleness visible.
 *
 * Run: `node .sandcastle/repo-map.check.mjs`
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = process.cwd();
const MAP = path.join(REPO, ".sandcastle", "REPO-MAP.md");
const GEN = path.join(REPO, ".sandcastle", "repo-map.mjs");

if (!fs.existsSync(MAP)) {
  console.error("REPO-MAP.md is missing — generate it: node .sandcastle/repo-map.mjs");
  process.exit(1);
}

// Regenerate to stdout and compare, so the check never writes the file it is
// judging — a check that repairs its own subject cannot report it as broken.
const fresh = execFileSync(process.execPath, [GEN, "--stdout"], { encoding: "utf8" });
const current = fs.readFileSync(MAP, "utf8");

if (fresh !== current) {
  console.error("REPO-MAP.md is stale — regenerate: node .sandcastle/repo-map.mjs");
  process.exit(1);
}

console.log(`repo-map check ok (${current.split("\n").length} lines)`);
