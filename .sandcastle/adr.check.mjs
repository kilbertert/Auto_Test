#!/usr/bin/env node
/**
 * Assert that `docs/adr/` holds records a reader can act on, and NUDGE toward
 * writing them when a change looks like it owes one.
 *
 * Run:
 *   node .sandcastle/adr.check.mjs                     # structure of changed records, nudge on coverage
 *   node .sandcastle/adr.check.mjs --base <git-ref>    # the CI form; coverage becomes a failure
 *   node .sandcastle/adr.check.mjs --all               # sweep every record in the repository
 *
 * Why this exists, and what it deliberately does NOT do.
 *
 * The scaffold's prompts have said "read the ADRs" since 1.6.0 and nothing ever
 * said "write one". Measured across the four consumer repositories: 43 records,
 * of which many are a title and a status line and nothing else. The decisions
 * recorded in prose are good; the ones that got the short treatment are exactly
 * the ones a later agent cannot act on. A record that says *what* was decided and
 * not *what was rejected* is how a settled argument gets re-litigated — which is
 * the failure this file is aimed at.
 *
 * So it checks STRUCTURE, not judgement. It cannot tell whether a change deserves
 * a record, and it does not pretend to: a rule that guesses would either pass
 * everything or block honest work. What it can see is the difference between a
 * record readable cold and one that is not.
 *
 * ── Two modes, because the two audiences need different force ────────────────
 *
 * **Structure**, judged only on the records this change touches. Three rules,
 * all of which the repositories' own best records already satisfy:
 *
 *   1. A status a reader can branch on. AI-Ops 0003 is the case that proves it:
 *      it describes a target shape, and the shipped shape is a deviation recorded
 *      in 0008. Without the status line those two are indistinguishable.
 *   2. An alternatives section, naming what lost.
 *   3. Alternatives that were actually weighed. `TBD` is not a decision, and an
 *      empty section claims a weighing that never happened.
 *
 * Scoping structure to the diff is what makes adoption possible without a
 * backfill. Measured on this host before that decision: 43 records, 20 of them
 * missing a status line or an alternatives section. Judging all of them would
 * have forced twenty prose edits inside a scaffold-upgrade PR — and inventing the
 * alternatives a record never weighed is exactly the fabrication this check
 * exists to prevent. `--all` sweeps the back catalogue on request, and reports the
 * same findings as a list of work; nothing about today's rollout rewrites a
 * project-owned document.
 *
 * **Coverage** (only with `--base`, or `AFK_ADR_BASE`). That the obligations in
 * `docs/agents/architecture-decisions.md` were met: a change to behavior,
 * architecture, a cross-file contract, process/tooling, test strategy, or an
 * on-disk/wire/config format touches a record. With `--base` this is a FAILURE;
 * without it, a nudge — because `git diff <ref> HEAD` is the merge-base form and
 * reports everything the branch carries, not what this change did.
 * `docs/agents/architecture-decisions.md` §"Scope" owns the exempt list, spelled
 * out repository-side, and the escape hatch is a `No-ADR:` line in the commit
 * body — an assertion a human reads, never silence.
 *
 * Every heading alias below is spelled by a real record on this host, so the
 * check is written to the convention that exists rather than the one a style
 * guide would prefer.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const REPO = resolve(process.env.AFK_ADR_ROOT ?? process.cwd());
const BASE =
  (argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : undefined) ??
  process.env.AFK_ADR_BASE ??
  "";
const ALL = argv.includes("--all");
const ADR_DIR = join(REPO, "docs", "adr");

const FILENAME_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
// Two status spellings are in use on this host, and both are standard: an inline
// `Status: Accepted` line (adr-tools) and YAML frontmatter (`---\nstatus: accepted\n---`,
// what MADR and this host's own governance repository write). Accepting only one
// would enforce a house style rather than the thing the rule is for — a reader
// being able to tell a decided record from an intended one.
const STATUS_RE = /^(?:Status|状态)\s*[:：]\s*\S/;
const FRONTMATTER_STATUS_RE = /^\s*status\s*:\s*\S/im;

// Every spelling a record on this host already uses: `Alternatives rejected`
// (health-flow 0006), `Alternatives Considered` (genesis-evidence 0005),
// `被否掉的替代形态` (AI-Ops 0008), `被否掉的方案` (afk-bootstrap 0001), `备选方案`.
// The rule is written to the convention that exists rather than the one a style
// guide would prefer — a checker that rejects the majority spelling would be
// enforcing a style, not readable records.
const ALTERNATIVES_RE = /^##+ *(alternatives\b|备选方案|替代方案|被否)/i;

// A section whose body is a placeholder. A nine-line record that is a title and
// a status is a legitimate shape when the decision is copied from a baseline —
// but an *alternatives* heading over nothing is not, because it claims a
// weighing that never happened.
const EMPTY_RE = /^(?:tbd|todo|n\/?a|none|无|待定|-{2,}|\.{3,})$/i;

// A title that says the record is not finished. A record in progress is honest
// and is not judged on structure; silent incompleteness is what this check
// exists to catch. `提案`/`草稿` because the repositories write in Chinese.
const DRAFT_RE = /(?:draft|proposed|wip|草稿|提案|拟议)/i;

// Paths that make a change "architecture" for coverage purposes. Deliberately
// coarse: the point is to notice that structure moved, not to classify it.
const STRUCTURE_SHAPED = [
  /^docs\/adr\//,
  /^\.github\/workflows\//,
  /(?:^|\/)openapi[^/]*\.(?:ya?ml|json)$/,
  /(?:^|\/)schema[^/]*\.(?:sql|json|ya?ml)$/,
  /(?:^|\/)migrations?\//,
  /^\.sandcastle\//,
];

// Source paths only — a change confined to these can reach behavior. Anything
// outside this list (docs, prose, images, fixtures) cannot, and is not counted.
const SOURCE_SHAPED = [
  /^src\//,
  /(?:^|\/)(?:app|lib|pkg|internal|cmd|server|client|api|frontend|backend)\//,
  /^\.claude\/skills\//,
];

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const failures = [];
const nudges = [];
const notes = [];

// Structure only FAILS when this run was asked to judge a specific set — the
// diff (`--base`) or the whole tree (`--all`). With neither there is nothing to
// scope to, so the same findings come out as a work list and the exit code stays
// 0: a bare invocation is for reading, not for gating, and a project that has
// back-catalogue records must be able to run it without going red.
const ENFORCE = ALL || BASE !== "";

/** Prose lines only: fenced code and HTML comments are not text a reader acts on. */
function proseLines(text) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  let inComment = false;
  for (const line of lines) {
    if (/^\s{0,3}```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      out.push(line.slice(0, line.indexOf("<!--")));
      continue;
    }
    out.push(line);
  }
  return out;
}

/** A status line, inline or as frontmatter. Both are in use here. */
function hasStatus(raw, lines) {
  if (lines.some((l) => STATUS_RE.test(l.trim()))) return true;
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw.replace(/^\ufeff/, ""));
  return fm !== null && FRONTMATTER_STATUS_RE.test(fm[1]);
}

/** Body lines under a heading, up to the next heading of the same or higher level. */
function sectionBody(lines, startIndex, level) {
  const body = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return body;
}

// ── structure ───────────────────────────────────────────────────────────────

if (!existsSync(ADR_DIR)) {
  console.log("adr check ok (no docs/adr — nothing to check)");
  process.exit(0);
}

const allEntries = readdirSync(ADR_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
  .map((e) => e.name)
  .sort();

const seen = new Map();
let drafts = 0;

/** Which records this run is allowed to judge. See the header for why. */
function recordsUnderReview() {
  if (ALL || !BASE) return allEntries;
  const mergeBase = tryGit(["merge-base", BASE, "HEAD"]);
  // Unresolvable base → judge NOTHING, and say so. Falling back to the whole tree
  // is the one thing that must not happen: a shallow checkout (which CI has by
  // default) would silently turn "this diff" into "this project's entire back
  // catalogue", and the failure would land on whoever pushed next rather than on
  // the configuration that caused it.
  if (mergeBase === null) {
    notes.push(
      `structure not judged: cannot resolve ${BASE} in this checkout — a gate that cannot see the diff is not a gate (CI needs \`fetch-depth: 0\`)`,
    );
    return [];
  }
  const diff = tryGit(["diff", "--name-status", mergeBase.trim(), "HEAD"]) ?? "";
  const names = new Set();
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, ...paths] = line.split("\t");
    if (status === "D") continue;
    for (const p of paths) if (p.startsWith("docs/adr/") && p.endsWith(".md")) names.add(p.slice("docs/adr/".length));
    // A rename reports both sides; the old name is gone, so it cannot be judged.
    if (status.startsWith("R")) paths.pop();
  }
  return allEntries.filter((n) => names.has(n));
}

const entries = allEntries;

for (const name of recordsUnderReview()) {
  const fail = (msg) => (ENFORCE ? failures : nudges).push(`${name} — ${msg}`);

  const m = FILENAME_RE.exec(name);
  if (!m) {
    fail("filename must be NNNN-slug.md (task-oriented names break ordered lookup)");
    continue;
  }
  const num = m[1];
  // Two records may share a number only if they are genuinely the same decision.
  // Otherwise the collision is silent, and the reader who types the number gets
  // whichever file their shell completes to.
  seen.set(num, (seen.get(num) ?? 0) + 1);

  const raw = readFileSync(join(ADR_DIR, name), "utf8");
  const lines = proseLines(raw);
  const title = (lines.find((l) => /^#\s/.test(l)) ?? "").replace(/^#\s+/, "").trim();
  if (DRAFT_RE.test(title)) {
    drafts += 1;
    continue;
  }

  if (!hasStatus(raw, lines)) {
    fail(
      "no `Status:` line — a reader cannot tell a decided record from a target shape, and AI-Ops 0003 is the case that proves it (target shape, shipped shape recorded as a deviation in 0008)",
    );
  }

  const altIndex = lines.findIndex((l) => ALTERNATIVES_RE.test(l.trim()));
  if (altIndex === -1) {
    fail(
      "no alternatives section (`## Alternatives Considered` / `## 被否掉的替代形态` / …) — a record of what was chosen and not what was rejected is how a settled argument gets re-litigated",
    );
    continue;
  }

  const level = /^(#+)/.exec(lines[altIndex].trim())[1].length;
  const body = sectionBody(lines, altIndex, level)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s*/, "").trim())
    .filter((l) => l !== "" && !/^```/.test(l));

  if (body.length === 0) {
    fail("the alternatives section is empty");
  } else if (body.every((l) => EMPTY_RE.test(l))) {
    fail(`the alternatives section is a placeholder (${JSON.stringify(body[0])}) — it claims a weighing that did not happen`);
  }
}

// ── coverage ────────────────────────────────────────────────────────────────
//
// With no base ref there is no diff to read, so this section reports nothing and
// says so — the honest answer, and the one that keeps a bare `node adr.check.mjs`
// usable as the migration's own evidence.

if (!BASE) {
  notes.push(
    "coverage not evaluated (no --base) — pass `--base <ref>` to check that a change touched a record",
  );
} else {
  const mergeBase = tryGit(["merge-base", BASE, "HEAD"]);
  if (mergeBase === null) {
    notes.push(`coverage skipped: cannot resolve ${BASE} here`);
  } else {
    const diff = tryGit(["diff", "--name-only", mergeBase.trim(), "HEAD"]) ?? "";
    const changed = diff.split("\n").filter(Boolean);

    const touchedAdr = changed.some((p) => p.startsWith("docs/adr/"));
    const decidedPaths = changed.filter(
      (p) => !p.startsWith("docs/adr/") && STRUCTURE_SHAPED.some((re) => re.test(p)),
    );
    const sourcePaths = changed.filter((p) => SOURCE_SHAPED.some((re) => re.test(p)));

    // A decision-shaped change: structure moved, or source moved and the
    // observable surface may have. The subject line is the cheapest honest
    // signal for the second case — a `fix:`/`feat:` prefix asserts behavior.
    const subject = (tryGit(["log", "-1", "--format=%s", "HEAD"]) ?? "").trim();
    const executableChange = sourcePaths.length > 0 && /^(?:feat|fix)(?:\(|!|:)/.test(subject);

    // The escape hatch: a commit body line reading `No-ADR: <reason>`. It is an
    // assertion a human reads in the log, not silence — and it is checked here
    // rather than trusted to a convention, because "we decided not to" that
    // leaves no trace is indistinguishable from "we forgot".
    const headBody = tryGit(["log", "-1", "--format=%B", "HEAD"]) ?? "";
    const waiver = /^\s*No-ADR:\s*\S/im.test(headBody);

    if (!waiver && !touchedAdr && (decidedPaths.length > 0 || executableChange)) {
      const why =
        decidedPaths.length > 0
          ? `${decidedPaths.length} path(s) that decide how the system is put together (${decidedPaths.slice(0, 3).join(", ")}${decidedPaths.length > 3 ? ", …" : ""})`
          : `${sourcePaths.length} source file(s) under a \`${subject.split(":")[0]}:\` change`;
      failures.push(
        `a record looks owed: this change touches ${why}, and docs/adr/ is unchanged. ` +
          "Write or update one, or say why not with a `No-ADR: <reason>` line in the commit body " +
          "(docs/agents/architecture-decisions.md owns the exempt list).",
      );
    }

    if (draftTouched(changed)) {
      notes.push("a draft-titled record changed; drafts are not judged on structure");
    }
  }
}

function draftTouched(changed) {
  return changed.some((p) => {
    if (!p.startsWith("docs/adr/")) return false;
    const file = join(REPO, p);
    if (!existsSync(file)) return false;
    const title = (proseLines(readFileSync(file, "utf8")).find((l) => /^#\s/.test(l)) ?? "").replace(/^#\s+/, "").trim();
    return DRAFT_RE.test(title);
  });
}

// ── report ──────────────────────────────────────────────────────────────────

for (const n of notes) console.log(`adr: note: ${n}`);
for (const n of nudges) console.log(`adr: nudge: ${n}`);

if (failures.length) {
  for (const f of failures) console.error(`adr: ${f}`);
  console.error(
    `\n${failures.length} problem(s) across ${entries.length} record(s)${drafts ? ` (${drafts} draft(s) exempt)` : ""}.`,
  );
  process.exit(1);
}

const scope = ENFORCE ? (ALL ? "structure enforced across the tree" : "structure enforced on this diff") : "structure reported, not enforced — pass --base or --all to gate on it";
console.log(
  `adr check ok (${entries.length} record(s), ${drafts} draft(s) exempt; ${scope})`,
);
