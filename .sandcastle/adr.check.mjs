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
 *
 * Note what this file does NOT do: it never READS the convention document. The
 * exempt list it cites is prose there — `## When a record is owed` — and the
 * decision above is made here, by `STRUCTURE_SHAPED` / `SOURCE_SHAPED` and the
 * `feat:`/`fix:` subject test. The escape hatch is a `No-ADR:` line in the commit
 * body — an assertion a human reads, never silence. (This paragraph used to cite
 * a `§"Scope"` section that does not exist in that document, which is how a
 * reference can look like a control for two releases without being one.)
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

// Whether this run was ASKED to gate, as distinct from whether it can.
//
// The distinction is the whole point of the next few lines. `AFK_ADR_BASE: ${{ … }}`
// evaluates to the empty string when neither side of the expression exists — and
// an empty string is falsy, so a guard written as `if (!BASE) report-only` turns a
// misconfigured workflow into a green run that looks exactly like a passing gate.
// Measured before this was fixed: `--base ""` exited 0.
//
// So the request is detected from the SPECIFICATION, not from the value: `--base`
// on the command line, or `AFK_ADR_BASE` present in the environment at all —
// including present-and-empty. Asking for a gate and supplying nothing is a
// configuration error, and it fails like one.
const baseFromArgv = argv.includes("--base");
const baseRequested = baseFromArgv || Object.prototype.hasOwnProperty.call(process.env, "AFK_ADR_BASE");
// Only a `--base` that is BOTH last and followed by a flag counts as a missing
// argument. `--base main --all` is a base ref directly followed by a flag, and
// reading `--all` as the ref would fail a run that was configured correctly.
// Neither branch falls back to the environment: `--base` on the command line
// means the command line answers, and falling through to `AFK_ADR_BASE` is how a
// workflow that passes `--base "$UNSET"` silently gates against something else.
const baseArg = baseFromArgv ? argv[argv.indexOf("--base") + 1] : undefined;
const baseArgMissing = baseFromArgv && (baseArg === undefined || baseArg.startsWith("--"));
const BASE = baseArgMissing ? "" : baseArg ?? process.env.AFK_ADR_BASE ?? "";
const ALL = argv.includes("--all");
const ADR_DIR = join(REPO, "docs", "adr");

// When an empty base is a configuration error, and when it is not.
//
// The two sources are not equivalent, and treating them alike is how this was
// wrong twice in a row:
//
//   * `--base ""` on the command line is someone asking for a diff and handing
//     over nothing. Always an error, `--all` or not: `--all` scopes the STRUCTURE
//     rules, it does not license skipping the coverage half that `--base` was
//     also asked for. Measured before this was fixed: `--all --base ""` exited 0
//     with coverage silently unevaluated.
//   * `AFK_ADR_BASE=""` is what a workflow's `${{ a || b }}` produces when neither
//     side exists, for every step that exports it. With `--all` there is a
//     complete instruction and nothing is missing, so it proceeds.
//
// A gate that silently downgrades to a report reads as passing exactly when it is
// misconfigured, which is the one moment it was needed.
const emptyBaseIsFatal = baseFromArgv ? true : !ALL;
if (baseRequested && BASE.trim() === "" && emptyBaseIsFatal) {
  const how = baseArgMissing
    ? "`--base` was passed with no ref"
    : "`AFK_ADR_BASE` is set but empty";
  console.error(
    `adr check failed: ${how}, so there is no diff to judge — refusing to report success.\n` +
      "  Supply one of:\n" +
      "    --base <ref>            e.g. `--base origin/main`, or the PR's base sha\n" +
      "    --all                   judge the whole tree instead of a diff\n" +
      "    (neither)               run locally for a report; exits 0 by design",
  );
  process.exit(1);
}

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

// The same vocabulary, at the START of a line rather than as a heading: a list
// item or a bolded lead-in that names the rejected set. See
// `alternativesLocation` for why both carriers have to count.
const INLINE_ALTERNATIVES_RE =
  /^(?:[-*+]\s+|\*\*|__)?\s*(?:alternatives\b|rejected\b|备选方案|替代方案|被否)/i;

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
const advisories = [];

// Structure only FAILS when this run was asked to judge a specific set — the
// diff (`--base`) or the whole tree (`--all`). With neither there is nothing to
// scope to, so the same findings come out as a work list and the exit code stays
// 0: a bare invocation is for reading, not for gating, and a project that has
// back-catalogue records must be able to run it without going red.
const ENFORCE = ALL || BASE !== "";

// Findings that must NOT fail the run, in any mode, because acting on them
// requires the original author's memory rather than work the reader can do.
//
// A record that never had an alternatives section is incomplete. A record that
// HAS one and left it empty is dishonest — it claims a weighing that did not
// happen. Only the second is the thing this check exists to catch, and its own
// `EMPTY_RE` comment says so. The convention says the same about the back
// catalogue, in `docs/agents/architecture-decisions.md` §"### The sweep":
//
//   those records "are worth a pass when someone next touches the decision they
//   describe; they are not worth a mechanical rewrite, and nobody should invent
//   alternatives a record never weighed just to turn a check green."
//
// Gating them would leave exactly two ways to a green run — invent the rejected
// options, or delete the record — and the convention forbids the first. A gate
// whose only honest exit is forbidden is the defect this channel exists to fix.
//
// What keeps this from weakening the gate for NEW work: the tier depends on the
// MODE, not only on the finding. `--base` judges the records the diff touches
// (recordsUnderReview()), and on that path a missing section is still a FAILURE —
// the author is at the keyboard and the record is theirs to finish. It becomes an
// advisory only on the whole-tree sweep (`--all`), where those authors are gone.
// That is the distinction the convention draws in §"### The sweep": the back
// catalogue is worth a pass "when someone next touches the decision they
// describe", and `--base` is exactly "someone touched it".
//
// `Status:` is deliberately NOT in this category, though it was in an earlier
// draft of this tier. Writing it invents nothing: on these repositories the fact
// is reachable from the tree. The `trusted-pr-control-plane` record has no status
// in four repositories, and each one's `.github/workflows/` shows the control
// plane shipped or not — the answer is one `grep` of the code the record is
// about, not a memory. What it is not reachable from is a naive reading of the
// record itself, which is exactly why the line has to be there: AI-Ops 0003
// carries `Status: Accepted` while a blockquote above it says the decision is
// unimplemented and 0008 records the deviation. A reader who branches on "there
// is a status line" is misled; a reader who branches on its VALUE is not.

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

/**
 * Where the rejected options are written, if they are written at all.
 *
 * Returns `{ heading, lines }` — the index of the heading that starts them, or -1
 * if they are carried inline — plus the lines that hold them.
 *
 * A HEADING IS NOT THE ONLY CARRIER, and requiring one produced a message that
 * was false. Measured on AI-Ops 0006, whose line 15 reads:
 *
 *   - 被否掉的替代形态：(a) 由统一助手入口中介跳转——…；(b) 后端维护路由白名单——…；(c) 显式判别类型字段——见上。
 *
 * That is the exact phrase `ALTERNATIVES_RE` hunts for, with three rejected
 * options and their reasons, and the check still said "no alternatives section …
 * a record of what was chosen and not what was rejected". Three records across
 * this host are in that shape (AI-Ops 0006 / 0007 / 0010). The vocabulary was
 * right; the carrier was wrong.
 *
 * So an annotated line counts. The marker is a list item or a bolded lead-in that
 * NAMES the rejected set — the same vocabulary, at the start of a line rather
 * than the start of a section. Requiring it at the start keeps the false-positive
 * rate at zero: the reason this check exists is a record that never weighed
 * anything, and a passing mention of "alternative" mid-sentence is not a weighing.
 */
function alternativesLocation(lines) {
  const heading = lines.findIndex((l) => ALTERNATIVES_RE.test(l.trim()));
  if (heading !== -1) {
    const level = /^(#+)/.exec(lines[heading].trim())[1].length;
    return { heading, lines: sectionBody(lines, heading, level) };
  }
  const inline = lines.filter((l) => INLINE_ALTERNATIVES_RE.test(l.trim()));
  return { heading: -1, lines: inline };
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
  // Fails only when the run judges THIS CHANGE'S records — `--base` without
  // `--all`. Then the author is at the keyboard and the record is theirs to
  // finish. On a whole-tree sweep (`--all`) the back catalogue's authors are not,
  // and the memory needed to finish those records is not available to anyone
  // reading the report. See the `advisories` declaration.
  const advisory = (msg) =>
    (BASE !== "" && !ALL ? failures : advisories).push(`${name} — ${msg}`);

  const m = FILENAME_RE.exec(name);
  if (!m) {
    fail("filename must be NNNN-slug.md (task-oriented names break ordered lookup)");
    continue;
  }
  const num = m[1];

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

  const alt = alternativesLocation(lines);
  if (alt.lines.length === 0) {
    // `advisory`, not `fail`: see its definition. An empty HEADING is caught
    // below instead, because a heading standing over nothing claims a weighing
    // that did not happen — that needs no memory to see and no memory to fix.
    const where = alt.heading === -1 ? "carried" : "under a heading";
    advisory(
      `no alternatives ${where} — a record of what was chosen and not what was rejected is how a settled argument gets re-litigated. Write the rejected options, or say in one line that none were considered \`(alternatives\b|备选方案|替代方案|被否)\``,
    );
    continue;
  }

  const body = alt.lines
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s*/, "").trim())
    .filter((l) => l !== "" && !/^```/.test(l));

  if (body.length === 0) {
    fail("the alternatives section is empty — a heading over nothing claims a weighing that did not happen");
  } else if (body.every((l) => EMPTY_RE.test(l))) {
    fail(`the alternatives section is a placeholder (${JSON.stringify(body[0])}) — it claims a weighing that did not happen`);
  }
}

// ── numbering ───────────────────────────────────────────────────────────────
//
// Two records sharing a serial is silent otherwise: the reader who types the
// number gets whichever file their shell completes to, and a citation resolves to
// the wrong decision. Measured on this host — three of the four consumer
// repositories already carry a `0002`, and one of them carries two.
//
// Built from EVERY record, not from the ones under review: a collision is a
// property of the numbering, and the other half of a pair is usually a record
// this change never touched. Scoping it to the diff would see a one-record
// "collision" and report nothing — which is how the first version of this table
// managed to be empty for exactly the case it exists for.
const numbering = new Map();
for (const name of allEntries) {
  const m = FILENAME_RE.exec(name);
  if (!m) continue;
  numbering.set(m[1], [...(numbering.get(m[1]) ?? []), name]);
}
// What counts as "this change's problem" depends on the scope, and it has to:
// a repository carrying a legacy collision must be able to adopt the rule without
// retiring that collision first. So
//   * `--all`      — every collision is the tree's problem, and the tree was asked
//                    about, so all of them fail;
//   * `--base`     — only a collision involving a record this change TOUCHES
//                    fails; the rest are reported, to be retired when someone next
//                    edits the pair;
//   * bare         — report only.
const underReview = new Set(recordsUnderReview());
for (const num of [...numbering.keys()].sort()) {
  const holders = numbering.get(num);
  if (holders.length < 2) continue;
  const msg = `number ${num} is used by ${holders.length} records (${holders.join(", ")}) — cite the one you mean by filename, and give the newcomer the next free number`;
  const isThisChange = !ALL && holders.some((h) => underReview.has(h));
  if (ENFORCE && (ALL || isThisChange)) failures.push(msg);
  else nudges.push(msg);
}

// ── coverage ────────────────────────────────────────────────────────────────
//
// Whether a record is OWED. Unlike the structure rules this needs no git history
// beyond the branch itself, which is what makes it the check that actually guards
// the pull request.
//
// Depth matters here, and the earlier design got it wrong. A local `git diff
// <ref> HEAD` is the merge-base form: it reports everything the branch carries,
// not what this change did — 1.7.11's tooling edits and 1.7.12's would land in
// that one diff together, and the tooling half would answer for the checker half.
// So the unit is the **commit**, judged against its own parent (and `HEAD^` is
// never shallow). The range also stops at the merge base, or a branch that is
// merely behind `main` reads `main`'s commits as its own.
//
// Two things this check cannot decide, both deliberately left to a human reading
// the diff:
//
//   - a commit that both changes source and adds a record PASSES, even if the
//     record is about something else. Judging that means reading prose.
//   - a commit whose body merely CONTAINS `No-ADR:` passes. The waiver is an
//     assertion a human reads in the log, not an authenticated one, and
//     pretending otherwise would be a worse lie than the one it prevents.

/** `<mergeBase>..HEAD`, or null when this run has no diff to judge. */
function coverageRange() {
  if (!BASE) return null;
  const mergeBase = tryGit(["merge-base", BASE, "HEAD"]);
  if (mergeBase === null) {
    // An unresolvable base FAILS, and the earlier version of this did not.
    //
    // Judging nothing and saying so reads as honest, and it is the wrong trade in
    // the one case that matters: a base ref that cannot be resolved is either a
    // shallow checkout — CI's default — or a typo, and in both the run was asked
    // to gate. Exiting 0 there means every commit this branch carries goes
    // unjudged while the log says "passed", which is a gate that fails open at
    // the exact moment it is misconfigured. Measured: `--base <unresolvable>`
    // exited 0 with a commit that owed a record.
    //
    // What must NOT happen is the other repair — falling back to the whole tree.
    // That turns "this diff" into "this project's entire back catalogue", and the
    // failure lands on whoever pushed next rather than on the configuration.
    const why = BASE.trim() === "" ? "no base ref was given" : `cannot resolve ${BASE} in this checkout`;
    console.error(
      `adr check failed: ${why}, so no commit can be judged — refusing to report success.\n` +
        "  A shallow checkout cannot see the base: CI needs `fetch-depth: 0`.\n" +
        "  If you meant to judge the whole tree instead of a diff, pass `--all`.",
    );
    process.exit(1);
  }
  return `${mergeBase.trim()}..HEAD`;
}

// `--all` scopes STRUCTURE, not coverage: "judge every record's shape" and "judge
// whether this range owes one" are independent questions, and `--all --base X` is
// a reasonable way to ask both. So this branch is gated on BASE alone.
if (!BASE) {
  notes.push(
    "coverage not evaluated (no --base) — pass `--base <ref>` to check that a change touched a record",
  );
} else {
  const range = coverageRange();
  if (range !== null) {
    const commits = (tryGit(["log", "--format=%H", range]) ?? "").split("\n").filter(Boolean);
    // One `git log` for every body and subject, rather than three subprocesses
    // per commit: this runs in CI on every push.
    const meta = new Map();
    for (const chunk of (tryGit(["log", "--format=%H%x00%s%x00%B%x01", range]) ?? "").split("\x01")) {
      const [sha, subject, body] = chunk.split("\0");
      if (sha) meta.set(sha.trim(), { subject: (subject ?? "").trim(), body: body ?? "" });
    }

    let flagged = 0;
    let waived = 0;
    for (const sha of commits) {
      const { subject, body } = meta.get(sha) ?? { subject: "", body: "" };
      // Three flags, each load-bearing:
      //   * `--root` — `diff <sha>^ <sha>` needs a parent, so a repository's first
      //     commit would be skipped, and the first commit is often the one that
      //     decides the layout.
      //   * `-m` — WITHOUT it `diff-tree` prints NOTHING for a two-parent commit
      //     (measured: `[]` for a merge, `[src/b.py src/c.py]` with it). A merge
      //     that resolved a conflict into a record-worthy change would be waived
      //     in silence.
      //   * `--first-parent` — with `-m` alone, paths are emitted once per parent.
      //     The question is what the merge brought in, which is the first-parent
      //     difference, so that is the one reported.
      // `--no-commit-id -r` keeps the output to paths, one per line.
      const changed = (
        tryGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", "--root", sha]) ?? ""
      )
        .split("\n")
        .filter(Boolean);
      const touchedAdr = changed.some((p) => p.startsWith("docs/adr/"));
      const decidedPaths = changed.filter(
        (p) => !p.startsWith("docs/adr/") && STRUCTURE_SHAPED.some((re) => re.test(p)),
      );
      const sourcePaths = changed.filter((p) => SOURCE_SHAPED.some((re) => re.test(p)));

      // A decision-shaped change: structure moved, or source moved and the
      // observable surface may have. The subject line is the cheapest honest
      // signal for the second case — a `feat:`/`fix:` prefix asserts behavior.
      const executableChange = sourcePaths.length > 0 && /^(?:feat|fix)(?:\(|!|:)/.test(subject);
      if (touchedAdr || (decidedPaths.length === 0 && !executableChange)) continue;

      // The waiver is matched against the body MINUS the subject line, so this
      // check's own prose — which quotes `No-ADR: <reason>` — cannot satisfy it.
      // A commit that says "we discussed No-ADR: …" in its title is not a waiver.
      const bodyOnly = body.replace(subject, "");
      const waiver = /^\s*No-ADR:\s*(\S.*)$/im.exec(bodyOnly);
      if (waiver) {
        waived += 1;
        notes.push(`${sha.slice(0, 8)} — "${subject}": waived (${waiver[1].trim()})`);
        continue;
      }

      const why =
        decidedPaths.length > 0
          ? `${decidedPaths.length} path(s) that decide how the system is put together (${decidedPaths.slice(0, 3).join(", ")}${decidedPaths.length > 3 ? ", …" : ""})`
          : `${sourcePaths.length} source file(s) under a \`${subject.split(":")[0]}:\` change`;
      flagged += 1;
      failures.push(
        `${sha.slice(0, 8)} "${subject}" — a record looks owed: this commit touches ${why}, and \`docs/adr/\` is unchanged. ` +
          "Write or update one, or say why not with a `No-ADR: <reason>` line in the commit body " +
          "(the shapes that owe nothing are listed in docs/agents/architecture-decisions.md § `## When a record is owed` — this check does not read that file).",
      );
    }
    notes.push(
      `coverage judged ${commits.length} commit(s) in ${range}${waived ? `, ${waived} waived` : ""}${flagged ? `, ${flagged} flagged` : ""}`,
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────

for (const n of notes) console.log(`adr: note: ${n}`);
for (const n of nudges) console.log(`adr: nudge: ${n}`);
for (const a of advisories) console.log(`adr: advisory: ${a}`);

if (failures.length) {
  for (const f of failures) console.error(`adr: ${f}`);
  console.error(
    `\n${failures.length} problem(s) across ${entries.length} record(s)${drafts ? ` (${drafts} draft(s) exempt)` : ""}${advisories.length ? `; ${advisories.length} advisory(ies) above, not counted` : ""}.`,
  );
  process.exit(1);
}

const scope = ENFORCE ? (ALL ? "structure enforced across the tree" : "structure enforced on this diff") : "structure reported, not enforced — pass --base or --all to gate on it";
const advisoriesNote = advisories.length
  ? `, ${advisories.length} advisory(ies) listed above (need the original author's memory, so they do not gate)`
  : "";
console.log(
  `adr check ok (${entries.length} record(s), ${drafts} draft(s) exempt; ${scope}${advisoriesNote})`,
);
