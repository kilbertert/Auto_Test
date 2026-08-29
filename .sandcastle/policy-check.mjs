#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.AFK_ROOT ?? process.cwd();
const command = process.argv[2] ?? "all";
const metadata = readJson(join(root, ".afk-bootstrap.json"), "metadata");
const contract = readJson(join(root, ".sandcastle/consensus-contract.json"), "consensus contract");

if (!["version", "exceptions", "workflows", "commit", "delivery", "all"].includes(command)) {
  fail(`Usage: node .sandcastle/policy-check.mjs [version|exceptions|workflows|commit|delivery|all]`);
}

if (command === "version" || command === "delivery" || command === "all") checkVersions();
if (command === "exceptions" || command === "delivery" || command === "all") checkExceptions();
if (command === "workflows" || command === "delivery" || command === "all") checkWorkflows();
if (command === "commit" || command === "delivery" || command === "all") checkBranch();
if (command === "commit" || command === "delivery" || command === "all") checkDiff();

console.log(`policy check passed: ${command}`);

function checkVersions() {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail("metadata and consensus contract must be JSON objects");
  }
  const consensus = metadata.consensus_version;
  const template = metadata.afk_template_version;
  const compatibility = metadata.consensus_compatibility;
  const contractConsensus = contract.consensus_version;
  const contractCompatibility = contract.afk_template_compatibility;
  for (const [name, value] of Object.entries({ consensus_version: consensus, afk_template_version: template, consensus_compatibility: compatibility })) {
    if (typeof value !== "string" || (name.endsWith("version") ? !semver(value) : !range(value))) fail(`invalid ${name}: ${value ?? "missing"}`);
  }
  if (!semver(contractConsensus) || !range(contractCompatibility)) fail("invalid consensus contract version or compatibility");
  if (consensus !== contractConsensus || compatibility !== contractCompatibility) {
    fail(`metadata/contract mismatch: consensus=${consensus}/${contractConsensus} compatibility=${compatibility}/${contractCompatibility}`);
  }
  if (!satisfies(consensus, compatibility)) fail(`consensus ${consensus} is outside compatibility ${compatibility}`);
}

function checkExceptions() {
  const file = join(root, ".afk-exceptions.json");
  if (!existsSync(file)) return;
  const value = readJson(file, "exceptions");
  const exceptions = Array.isArray(value) ? value : value && typeof value === "object" ? value.exceptions : undefined;
  if (!Array.isArray(exceptions)) fail("exceptions must be an array or { exceptions: [] }");
  const known = new Set(contract.invariants ?? []);
  const blocked = new Set(contract.non_exceptionable_invariants ?? []);
  for (const [index, item] of exceptions.entries()) {
    if (!item || typeof item !== "object") fail(`exception ${index + 1} must be an object`);
    for (const field of ["invariant", "reason", "scope", "compensating_control", "owner", "approved_at", "expires_at"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) fail(`exception ${index + 1} missing ${field}`);
    }
    if (!known.has(item.invariant)) fail(`exception ${index + 1} names unknown invariant: ${item.invariant}`);
    if (blocked.has(item.invariant)) fail(`exception ${index + 1} cannot waive non-exceptionable invariant: ${item.invariant}`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item.approved_at) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item.expires_at)) fail(`exception ${index + 1} timestamps must be UTC ISO-8601`);
    const approved = Date.parse(item.approved_at);
    const expires = Date.parse(item.expires_at);
    if (!Number.isFinite(approved) || !Number.isFinite(expires) || approved > Date.now() || expires <= approved) fail(`exception ${index + 1} has invalid approval/expiry timestamps`);
    if (expires <= Date.now()) fail(`exception ${index + 1} expired at ${item.expires_at}`);
  }
}

function checkWorkflows() {
  const directory = join(root, ".github/workflows");
  const pullRequestWorkflows = ["agent-implement-pr.yml", "agent-review.yml", "agent-update-branch.yml"];
  const deliveryWorkflows = ["agent-implement.yml", "agent-implement-prd.yml", "agent-promote-queued.yml"];

  for (const name of pullRequestWorkflows) {
    const source = stripYamlComments(readText(join(directory, name), name));
    for (const required of [
      "path: controller",
      "path: candidate",
      "path: delivery",
      "contents: read",
      "../controller/node_modules/.bin/tsx",
      "trusted-pr-delivery.sh",
      "AFK_AGENT_READ_TOKEN",
      "AFK_READ_TOKEN",
      "GH_TOKEN: ${{ secrets.AGENT_PAT }}",
      "agent:blocked",
    ]) {
      if (!source.includes(required)) fail(`${name} is missing trusted PR control: ${required}`);
    }
    for (const required of [
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.event.pull_request.user.login == github.repository_owner",
    ]) {
      if (!hasJobIfExpression(source, required)) fail(`${name} is missing trusted PR control: ${required}`);
    }
    if (source.match(/^    env:\n(?: {6}.*\n)* {6}GH_TOKEN:/m)) fail(`${name} exposes GH_TOKEN to the whole job`);
    for (const step of source.split(/\n(?= {6}- name:)/)) {
      if (step.includes("run: npm ci") && !step.includes("working-directory: controller")) {
        fail(`${name} installs untrusted host dependencies`);
      }
      if (step.includes("working-directory: candidate") && step.includes("GH_TOKEN:") && !step.includes("AFK_AGENT_READ_TOKEN")) {
        fail(`${name} exposes a write token to the candidate checkout`);
      }
      if (step.includes("Push result from clean delivery workspace") && !step.includes("secrets.AGENT_PAT")) {
        fail(`${name} does not use AGENT_PAT for the final push`);
      }
    }
    rejectUnsafeWorkflowText(name, source);
  }

  for (const name of deliveryWorkflows) {
    const source = stripYamlComments(readText(join(directory, name), name));
    for (const required of ["AGENT_PAT", "agent:blocked"]) {
      if (!source.includes(required)) fail(`${name} is missing fail-closed delivery control: ${required}`);
    }
    if (name === "agent-implement-prd.yml" || name === "agent-implement.yml") {
      const pushStep = source.split(/\n(?= {6}- name:)/).find((step) => step.includes("- name: Push branch"));
      if (!pushStep || !pushStep.match(/^ {10}GH_TOKEN:\s*\$\{\{\s*secrets\.AGENT_PAT\s*\}\}\s*$/m)) {
        fail(`${name} does not use AGENT_PAT for branch pushes`);
      }
      if (name === "agent-implement-prd.yml" && source.indexOf("- name: Close completed sub-issue") < source.indexOf("- name: Open draft PR if one doesn't exist for this branch")) {
        fail(`${name} closes the ticket before PR delivery succeeds`);
      }
    }
    rejectUnsafeWorkflowText(name, source);
  }
}

function rejectUnsafeWorkflowText(name, source) {
  if (source.includes("skills@latest")) fail(`${name} installs a provider-specific skill at runtime`);
  if (source.includes("GITHUB_TOKEN_FALLBACK")) fail(`${name} falls back to a token that cannot trigger workflows`);
  if ((name === "agent-implement.yml" || name === "agent-implement-prd.yml") && source.includes("|| echo")) {
    fail(`${name} masks a GitHub API failure with a permissive default`);
  }
  if (/git\s+push[^\n]*--force(?:-with-lease)?/.test(source)) fail(`${name} force-pushes`);
}

function checkBranch() {
  let branch;
  try {
    branch = git(["symbolic-ref", "--short", "HEAD"]);
  } catch {
    fail("cannot determine the current branch");
  }
  const defaultBranch = process.env.AFK_DEFAULT_BRANCH || defaultBranchFromGit();
  if (!branch || branch === defaultBranch) fail(`protected default branch cannot be used by AFK: ${branch || "unknown"}`);
}

function checkDiff() {
  const result = execFileSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
  if (result.trim()) fail(`git diff --check failed:\n${result}`);
}

function defaultBranchFromGit() {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function stripYamlComments(source) {
  return source.split(/\r?\n/).map((line) => {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (quote === '"') {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = "";
        continue;
      }
      if (quote === "'") {
        if (character === "'" && line[index + 1] === "'") index++;
        else if (character === "'") quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
        return line.slice(0, index).trimEnd();
      }
    }
    return line;
  }).join("\n");
}

function hasJobIfExpression(source, expression) {
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)if:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    let value = match[2];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next];
      if (line.trim() && line.search(/\S/) <= indent) break;
      value += `\n${line}`;
    }
    if (value.includes(expression)) return true;
  }
  return false;
}

function semver(value) { return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value); }
function versionParts(value) {
  const [main, prerelease] = value.split("-", 2);
  return { numbers: main.split(".").map(Number), prerelease: prerelease ? prerelease.split(".") : [] };
}
function compare(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    if (a.prerelease[i] === b.prerelease[i]) continue;
    const aNumeric = /^\d+$/.test(a.prerelease[i]); const bNumeric = /^\d+$/.test(b.prerelease[i]);
    if (aNumeric && bNumeric) return Number(a.prerelease[i]) - Number(b.prerelease[i]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.prerelease[i] < b.prerelease[i] ? -1 : 1;
  }
  return 0;
}
function range(value) {
  return value.trim().split(/\s+/).every((part) => /^(>=|>|<=|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(part));
}
function satisfies(version, compatibility) {
  return compatibility.trim().split(/\s+/).every((part) => {
    const match = part.match(/^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/); const relation = match?.[1] ?? "=";
    const result = compare(version, match[2]);
    return relation === ">=" ? result >= 0 : relation === ">" ? result > 0 : relation === "<=" ? result <= 0 : relation === "<" ? result < 0 : result === 0;
  });
}
function fail(message) { console.error(`policy check failed: ${message}`); process.exit(1); }
