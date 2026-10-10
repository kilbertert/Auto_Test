#!/usr/bin/env node
/**
 * Assert `.sandcastle/REPO-MAP.md` exists, matches what the generator produces,
 * AND carries the sandbox's MCP contract.
 *
 * A stale map is worse than a missing one: the agent reads it with the same
 * confidence as the code, and it silently points at files that moved. This is
 * what makes the staleness visible.
 *
 * The MCP section is asserted here rather than trusted for the same reason, in
 * the other direction: every part of that contract fails SILENTLY.
 *
 *   - the graph is indexed under a name derived from the *path*, which inside a
 *     sandbox is always `/home/agent/workspace`, so the agent's natural guess
 *     (`AI-Ops`) misses and it falls back to grep — measured in a real run, at a
 *     cost of 3.7 minutes and a `list_projects` detour;
 *   - the name is required per CALL and cannot be defaulted by the MCP config
 *     (the binary ignores `--project` on the server path), so what this file
 *     says is the only place the agent can learn it;
 *   - the `project not found` error it gets instead does list the real name, but
 *     only after it has already concluded the tool is broken.
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

// The *generated* text is what the contract is checked against, not the file on
// disk: the regeneration above guarantees they are identical, and asserting on
// the generator is what makes a hand-deleted section appear (it is regenerated)
// while a section the generator stopped emitting fails here.
if (!/^## Code intelligence$/m.test(fresh)) {
  console.error(
    "REPO-MAP.md has no `## Code intelligence` section — the agent has no way to learn what name the knowledge graph answers to, and its first guess costs minutes",
  );
  process.exit(1);
}

// The name the agent must pass is the one the index hook indexes under. Both
// come from the same manifest field, so comparing them here is what keeps a
// rename on one side from shipping a confidently-wrong instruction on the other.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, ".afk-bootstrap.json"), "utf8"));
const expected = String(manifest.repository ?? "").split("/").pop();
if (!expected) {
  console.error(".afk-bootstrap.json has no repository; the graph project name cannot be derived");
  process.exit(1);
}
if (!fresh.includes(`"project": "${expected}"`)) {
  console.error(
    `REPO-MAP.md does not tell the agent to pass "project": "${expected}" — the name the index hook indexes under`,
  );
  process.exit(1);
}

console.log(`repo-map check ok (${current.split("\n").length} lines, graph project ${expected})`);
