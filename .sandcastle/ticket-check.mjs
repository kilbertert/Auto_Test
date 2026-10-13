#!/usr/bin/env node
/**
 * Decide whether a ticket is one an agent could finish without a human standing
 * next to it — and say exactly what is missing when it is not.
 *
 * Run:
 *   node .sandcastle/ticket-check.mjs --title "…" --body-file /tmp/b.md
 *   node .sandcastle/ticket-check.mjs --json            < one-ticket.json
 *   node .sandcastle/ticket-check.mjs --manifest <f|->  # every ticket in a list
 *   node .sandcastle/ticket-check.mjs --manifest <f> --min-pass 0.6
 *   node .sandcastle/ticket-check.mjs --self-check
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The workflow has a shape gate: `agent-implement.yml` refuses a PRD, a
 * sub-issue, and an issue with an open native blocker. Every one of those is
 * about a ticket's POSITION. Nothing has ever checked whether the ticket says
 * what to build and what "done" looks like — so the authorization label
 * `agent:implement` opens a door whose other side is judged by nobody.
 *
 * Measured on this host before writing this file (open issues, per repository):
 *
 *   repo                open w/ body   has acceptance   has non-goals
 *   Health-Flow                     0                –               –
 *   genesis-evidence                5              3/5             3/5
 *   AI-Ops                         14             3/14            8/14
 *   Auto_Test                      27            11/27           11/27
 *
 * and on the `ready-for-agent` label — the one a planner treats as "run it":
 * 12 tickets across three repositories, of which **one** carried acceptance
 * criteria. The shape gate is not the constraint. This is.
 *
 * The forcing case came from outside GitHub. This host's ZenTao instance
 * (22.2, REST API, `zentao-cli` MCP) holds 116 products of requirement tickets
 * whose only field is a title — measured: 20/20 in one product and 14/14 in one
 * project have an empty `spec` AND an empty `verify`. A ticket like
 * `视频详情页面主图需要调整大小，增加主图框===泉哥（需出原型给开发，如抖音）`
 * cannot be started, because there is no observable outcome to build toward;
 * an agent handed it will invent one, and the invention is the cost.
 *
 * So the first thing a requirements platform needs is not a connector. It is a
 * judgement about the ticket, and that judgement is worth having locally first.
 *
 * ── What it judges, and what it refuses to ───────────────────────────────────
 *
 * STRUCTURE only. Four of the seven rules are the same question asked of
 * different sections — "does this text exist, is it non-empty, does it name
 * something checkable" — and none of them require understanding the change.
 * The two advisory rules (non-goals, problem statement) are warnings and never
 * affect the exit code: they are real signals, but a ticket without them is a
 * worse ticket rather than an unrunnable one, and a check that fails on taste
 * gets switched off.
 *
 * What it cannot do, and does not pretend to: tell whether the acceptance
 * criteria are the RIGHT ones, whether the named files are the ones that
 * actually change, or whether the work is worth doing. A ticket can satisfy
 * every rule here and still be a bad idea. This gate is the floor, not the
 * ceiling.
 *
 * A PRD is exempt — and passed, not failed. It is a container: the workflows
 * refuse to implement one and route it to its sub-issues instead, so holding it
 * to a leaf ticket's bar would fail the document that every good sub-issue
 * comes from. `isPrd` uses the same three headings `planner.ts` already uses,
 * so the two agree about what a PRD is rather than defining it twice.
 *
 * ── The escape hatch, and why it is an assertion rather than silence ─────────
 *
 * Some tickets legitimately owe no acceptance criteria in their body — the
 * contract lives in a spec, in a parent PRD, or in a linked test. Say so, on
 * its own line, in the ticket or in the commit body:
 *
 *     No-acceptance: figures come from docs/perf-baseline.md, asserted in test
 *
 * That line is checked, because a deliberate decision not to write something
 * and a decision forgotten are indistinguishable in a diff — and only one of
 * them is fine. It is not authenticated: a line that merely *contains*
 * `No-acceptance:` counts. What it buys is that a human reading the ticket sees
 * a reason.
 */
import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Argument handling
//
// Deliberately the same shape as `adr.check.mjs`, because that is the form this
// host has already established: a bare invocation reports and exits 0, and a
// gate is something you ASK for. Asking for a gate and supplying it nothing is
// a configuration error and fails like one — the alternative reads as passing
// at exactly the moment it is misconfigured.
function flagValue(name) {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const next = argv[at + 1];
  // `--title --json` is a missing argument, not a title.
  return next === undefined || next.startsWith("--") ? "" : next;
}
const hasFlag = (name) => argv.includes(name);

const TITLE = flagValue("--title");
const BODY = flagValue("--body");
const BODY_FILE = flagValue("--body-file");
const MANIFEST = flagValue("--manifest");
const MIN_PASS_RAW = flagValue("--min-pass");
const SELF_CHECK = hasFlag("--self-check");
const JSON_MODE = hasFlag("--json");
// Report by default; `--strict` is how a caller asks for a gate. The two are
// separated for the same reason `adr.check.mjs` separates them: a command that
// gates unless told otherwise is unusable for reading, and a command that
// reports unless told otherwise is a gate nobody remembers to ask for.
const STRICT = hasFlag("--strict");

const EXPLICIT = TITLE !== undefined || BODY !== undefined || BODY_FILE !== undefined || MANIFEST !== undefined || JSON_MODE;
if (EXPLICIT && argv.some((a) => ["--title", "--body", "--body-file", "--manifest"].includes(a) && flagValue(a) === "")) {
  console.error(
    "ticket check failed: a flag was passed with no value — refusing to report success.\n" +
      "  --title <text> / --body <text> / --body-file <path> / --manifest <path|->",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The rules
//
// Every heading alias below is a spelling a real ticket on this host already
// uses, so the check is written to the convention that exists rather than the
// one a style guide would prefer. The rule for adding one: it must appear in a
// ticket someone actually wrote, or it is a style being enforced.

/** Acceptance-shaped sections. Both `## Acceptance criteria` and a bare `验收`. */
const ACCEPTANCE_RE =
  /^#{1,6} *(acceptance|验收|完成标准|期望(?:行为|结果)|done when|definition of done|deliverable|取证)/i;
/** The inline-label form, which needs no heading at all. */
const ACCEPTANCE_LABEL_RE = /^\s*(?:\*\*)?\s*(acceptance(?: criteria)?|验收(?:标准)?)(?:\*\*)?\s*[:：]/i;

const NON_GOALS_RE =
  /^#{1,6} *(不做什么|不做|范围外|不包含|非目标|out of scope|non-goals?|not in scope|boundar)/i;
const PROBLEM_RE = /^#{1,6} *(problem|背景|问题|为什么|动机|rationale|why|motivation|现象)/i;

const EMPTY_RE = /^(?:tbd|todo|n\/?a|none|无|待定|-{2,}|\.{3,}|—+)$/i;
/** A checkbox or a bulleted/numbered line — the two shapes a criterion takes. */
const ITEM_RE = /^\s*(?:[-*+] +\[[ xX]\]|[-*+] +|\d+[.)] +)\S/;
/**
 * A checkbox with nothing after it.
 *
 * `ITEM_RE`'s generic bullet arm matches `- [ ]` — the checkbox arm fails for
 * lack of a `\S`, so the bullet arm takes it and the `[ ]` becomes "criterion
 * text". Measured before this existed: a ticket whose whole acceptance section
 * was one empty checkbox passed, once it named a file anywhere else in the body.
 * An empty checkbox claims an outcome that was never written, which is the exact
 * thing the empty-section rule exists to catch.
 */
const BARE_CHECKBOX_RE = /^\s*[-*+] +\[[ xX]\]\s*$/;
/** Something a reader can check mechanically: a code span, or a path/command. */
const CHECKABLE_RE = /`[^`\n]+`|(?:^|\s)(?:src|tests?|docs|app|lib|pkg|internal|cmd|scripts|\.[a-z]+)\/[\w./-]+/;

/**
 * Something concrete the work can be located by — a code span, or a path.
 *
 * A code span counts even when it is not path-shaped, and that is deliberate: a
 * symbol (`ScopeContext`), a command (`git rev-parse --show-toplevel`), or a
 * config key locates the work just as well as a filename does, and a
 * verification ticket ("run these four things") may change no file at all.
 * Measured: one live ticket on this host is exactly that shape, and failing it
 * would have taught its author that this gate is noise.
 */
const ANCHOR_RE = /`[^`\n]{2,}`|\b(?:src|tests?|docs|app|lib|pkg|internal|cmd|scripts)\/[\w./-]+\b/;

/**
 * A ticket that still contains an unresolved choice is not one an agent can
 * finish, however well it is written.
 *
 * This is not a style rule and it is not negotiable by the author: if a ticket
 * says "preferred: A, fallback: B" or "needs product to decide", then whoever
 * picks has made a product decision, and an agent picking is how a guess ships
 * as a fix. It is worth a rule of its own rather than a warning, because it is
 * the one thing a waiver cannot cover — `No-acceptance:` says "the contract is
 * elsewhere"; it cannot say "and I know which of two designs to build".
 *
 * Measured: this is what a well-written investigation ticket looks like on this
 * host, and the first version of this check passed one of them. `首选/次选` is
 * the author's own word for the fork, so the rule is written on that word — the
 * option pair must actually be present, because a lone `首选` in prose is not a
 * fork in the road, and a false positive here blocks work that was fine.
 */
const DECISION_RES = [
  [/二选一/, "the ticket offers a choice between two things"],
  [/首选[\s\S]{0,800}?次选|次选[\s\S]{0,800}?首选/, "the ticket lists a preferred option and a fallback"],
  [/(?:^|[\s，。、:：])(?:待定|待确认|TBD)(?=$|[\s，。、])/im, "the ticket leaves a required decision as TBD"],
];

/** The three headings `planner.ts` uses, plus the title form. One definition. */
function isPrd(title, body) {
  return (
    /\bprd\b|\[spec\]/i.test(title) ||
    (/^##+ *Problem Statement/m.test(body) && /^##+ *Solution/m.test(body) && /^##+ *User Stories/m.test(body))
  );
}

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

/** Body lines under a heading, up to the next heading of the same or higher level. */
function sectionBody(lines, startIndex) {
  const level = /^(#+)/.exec(lines[startIndex])[1].length;
  const body = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return body;
}

/**
 * An item's text, with the marker removed.
 *
 * `ITEM_RE` ends in `\S`, so `replace(ITEM_RE, "")` strips the marker AND one
 * character of the content — enough to turn `- TBD` into `BD`, which is not a
 * placeholder any more and passed as a real criterion. Measured. The marker is
 * captured separately instead, and the text is whatever follows it.
 */
function itemText(line) {
  const m = /^\s*(?:[-*+] +\[[ xX]\]|[-*+] +|\d+[.)] +)([\s\S]*)$/.exec(line);
  return m ? m[1].trim() : "";
}

/** Is this list of lines a criterion — non-empty, and not a placeholder? */
function itemLines(body) {
  return body.filter((l) => {
    if (!ITEM_RE.test(l) || BARE_CHECKBOX_RE.test(l)) return false;
    const text = itemText(l);
    return text !== "" && !EMPTY_RE.test(text);
  });
}

/**
 * The criteria under a heading, stopping where the list stops.
 *
 * A section runs to the next heading of the same or higher level, but a
 * criterion list is contiguous: prose that follows a blank line is the next
 * thought, not another criterion. Without the second rule, `## Acceptance
 * criteria` followed by a note about a related file swallows the note, and the
 * rule "there is at least one criterion" is answered by text that is not one.
 */
function criteriaBody(lines, startIndex) {
  const body = sectionBody(lines, startIndex);
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (!body[i].trim()) {
      // A blank line only continues the list when an item follows it.
      const next = body.slice(i + 1).find((l) => l.trim());
      if (next === undefined || !ITEM_RE.test(next)) break;
      continue;
    }
    out.push(body[i]);
  }
  return out;
}

/**
 * The acceptance answer, from a heading, an inline label, or — for tickets that
 * state their criteria as a bare list of commands — the body itself.
 *
 * That third form is not a loophole. A verification ticket ("run these four
 * things, report what you get, change no product code") has no heading and no
 * need of one; what it has is a list of mechanically checkable steps, which is
 * the same thing the rule is asking for under a different name. Measured: two
 * such tickets are live on this host, and failing them would have taught their
 * authors that the gate is noise.
 */
function acceptance(lines) {
  const at = lines.findIndex((l) => ACCEPTANCE_RE.test(l));
  if (at >= 0) {
    const items = itemLines(criteriaBody(lines, at));
    return items.length > 0
      ? { ok: true, how: "section" }
      : { ok: false, how: "section-empty", section: lines[at].trim() };
  }
  const label = lines.findIndex((l) => ACCEPTANCE_LABEL_RE.test(l));
  if (label >= 0) {
    // The label's own line, then whatever list follows it.
    const rest = [lines[label].replace(ACCEPTANCE_LABEL_RE, "")].filter((s) => s.trim() && !EMPTY_RE.test(s.trim()));
    const after = [];
    for (let i = label + 1; i < lines.length; i++) {
      if (/^#{1,6} /.test(lines[i])) break;
      after.push(lines[i]);
    }
    return [...rest, ...itemLines(after)].length > 0
      ? { ok: true, how: "label" }
      : { ok: false, how: "label-empty" };
  }
  // No heading, no label. A run of checkable steps is the same statement.
  const checkable = lines.filter((l) => ITEM_RE.test(l) && CHECKABLE_RE.test(l));
  if (checkable.length >= 2) return { ok: true, how: "steps" };
  return { ok: false, how: "absent" };
}

const WAIVER_RE = /^\s*(?:\*\*)?\s*No-acceptance\s*:/im;

/**
 * Judge one ticket. Pure — no I/O — so the self-check runs the same code the
 * CLI does, which is the lesson `repo-map.mjs` cost this repository once
 * already: an assertion against a helper the shipping path does not use passes
 * while the shipped artifact is wrong.
 */
export function judge(ticket) {
  const title = String(ticket.title ?? "").trim();
  const body = String(ticket.body ?? "").trim();
  const lines = proseLines(body);

  const findings = [];
  const notes = [];
  const fail = (id, detail) => findings.push({ id, level: "fail", detail });
  const warn = (id, detail) => findings.push({ id, level: "warn", detail });

  // Declared before the first use, and `done` is a hoisted declaration rather
  // than a closure over state declared below it: the title/body early return
  // needs both, and reading a `const` before its line is a `ReferenceError`
  // rather than the `undefined` the surrounding code reads like.
  const waived = WAIVER_RE.test(body);
  const prd = isPrd(title, body);

  function done() {
    return {
      ok: findings.every((f) => f.level !== "fail"),
      findings,
      notes,
      prd,
      waived,
    };
  }

  if (!title) fail("title", "the ticket has no title");
  if (!body) {
    fail("body", "the ticket has no body — a title is not a specification");
    return done();
  }

  if (prd) {
    notes.push(
      "this is a PRD — it is not implemented directly, so this gate passes it and its sub-issues each face this check",
    );
    return done();
  }

  const acc = acceptance(lines);
  if (!acc.ok) {
    if (waived) {
      notes.push(`no acceptance criteria, waived by a \`No-acceptance:\` line (${acc.how})`);
    } else if (acc.how === "absent") {
      fail(
        "acceptance",
        "no acceptance criteria — add an `## Acceptance criteria` section (or `验收`), a list of checkable steps, or a `No-acceptance:` line saying where the contract lives",
      );
    } else {
      fail("acceptance", "the acceptance section is empty — a heading over nothing claims a decision nobody made");
    }
  }

  if (!ANCHOR_RE.test(body)) {
    fail(
      "anchor",
      "the ticket names nothing concrete to work from — no file, symbol, command or code span — so an agent cannot tell where the change belongs, and will guess",
    );
  }

  // Not waiverable — deliberately NOT behind the `waived` flag. A waiver names
  // where the contract lives; it cannot name which of two designs to build. See
  // DECISION_RES.
  for (const [re, detail] of DECISION_RES) {
    if (re.test(body)) {
      fail("undecided", `${detail} — settle it and record the answer before authorising the work`);
      break;
    }
  }

  if (!NON_GOALS_RE.test(body)) warn("non-goals", "no `Out of scope` / `不做什么` section — nothing bounds the change");
  if (!PROBLEM_RE.test(body)) warn("problem", "no `Problem` / `背景` section — the reason is not written down");

  return done();
}

// ---------------------------------------------------------------------------
// Input normalisation
//
// Three shapes arrive here and they are not the same shape:
//
//   * `gh issue view --json title,body`            → { title, body }
//   * `planner.ts`'s issue list                    → [{ number, title, body }]
//   * `zentao ls story --format json`              → { status, data: [{ title, spec, verify }] }
//
// The third one is why this normaliser exists rather than a `--title --body`
// pair alone: ZenTao calls the field `spec`, stores HTML in it, and keeps its
// acceptance answer in a separate `verify` field. Reading only `body` would
// report every ZenTao ticket as an empty one, which is a fact about this
// parser, not about the tickets.
function normalise(item) {
  const title = item.title ?? item.name ?? "";
  let body = item.body ?? item.spec ?? item.description ?? item.content ?? "";
  if (typeof body !== "string") body = "";
  // ZenTao stores HTML. Left in, every `<p>` reads as prose and the anchor rule
  // matches inside a tag. Strip it, then unescape the entities it always emits.
  if (/<\/(?:p|div|li|br|h[1-6]|table)>|<br\s*\/?>/i.test(body)) {
    body = body
      .replace(/<\/(?:p|div|li|h[1-6]|table|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
      .replace(/<br\s*\/?>/gi, "\n")
      // `<code>`/`<pre>` is how ZenTao marks a symbol or a literal — the same
      // thing a markdown backtick marks — so dropping the tag loses the anchor
      // and a symbol-bearing ticket reads as one that names nothing. Convert it
      // to the spelling ANCHOR_RE already recognises, before the tags go.
      .replace(/<(code|pre)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `\`${inner.trim()}\``)
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  // `verify` is ZenTao's own acceptance field. When it is filled in, it IS the
  // answer, and the check should read it rather than report it missing.
  const verify = typeof item.verify === "string" ? item.verify.trim() : "";
  // `verify` is ZenTao's own acceptance field, so when it is filled in it IS the
  // answer. Asking whether the body has an acceptance HEADING is not the same
  // question: a `## Acceptance criteria` over nothing is exactly the case where
  // the sibling field carries the content, and testing for the heading discarded
  // it. Ask the real predicate instead.
  if (verify && !acceptance(proseLines(body)).ok) {
    // Filled into the section that is already there, not appended as a second
    // heading. `## Acceptance criteria` followed by an empty one is not a
    // duplicate a reader can read past — the check looks at the FIRST heading of
    // that shape, finds nothing under it, and reports the ticket as empty while
    // the answer sits two lines below. Measured, after an earlier version did
    // exactly that.
    // A list or a checkbox is already a criterion; prose is not, so it is given
    // the marker the rule asks for. ZenTao's `verify` field is written by hand
    // and often a sentence ("报告显示更新后的数值"), and inserting that verbatim
    // under the heading left the ticket failing the rule that the field exists
    // to answer. Each non-empty line becomes one criterion.
    const crit = verify
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (ITEM_RE.test(l) ? l : `- ${l}`))
      .join("\n");
    const lines = body.split("\n");
    const at = lines.findIndex((l) => ACCEPTANCE_RE.test(l));
    body =
      at >= 0
        ? [...lines.slice(0, at + 1), "", crit, ...lines.slice(at + 1)].join("\n")
        : `${body}\n\n## Acceptance criteria\n\n${crit}\n`;
  }
  return { title: String(title), body, label: item.number !== undefined ? `#${item.number}` : String(title).slice(0, 48) };
}

/** Accept any of the three shapes, and refuse an unrecognisable one loudly. */
function ticketsFrom(parsed) {
  if (Array.isArray(parsed)) return parsed.map(normalise);
  if (parsed && Array.isArray(parsed.data)) return parsed.data.map(normalise);
  if (parsed && Array.isArray(parsed.tickets)) return parsed.tickets.map(normalise);
  if (parsed && typeof parsed === "object") return [normalise(parsed)];
  throw new Error("input is not a ticket, a list of tickets, or a `{ data: [...] }` list");
}

// ---------------------------------------------------------------------------
// Reporting

function reportOne(t, { verbose = false } = {}) {
  const r = judge(t);
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${t.label}`);
  for (const f of r.findings) {
    if (f.level === "warn" && !verbose) continue;
    console.log(`    ${f.level === "fail" ? "missing" : "warning"}: ${f.detail}`);
  }
  for (const n of r.notes) console.log(`    note: ${n}`);
  return r;
}

// ---------------------------------------------------------------------------
// Self-check. The fixtures are the real shapes measured on this host — a
// ticket written for an agent, a research report that is legitimately not one,
// a PRD, and a ZenTao ticket whose only field is a title.
if (SELF_CHECK) {
  let failed = 0;
  const expect = (label, got, want) => {
    if (got !== want) {
      console.error(`self-check FAIL: ${label} — got ${got}, wanted ${want}`);
      failed++;
    }
  };
  const F = {
    // Auto_Test #210, abridged: `## What to build` + `## Acceptance criteria`.
    criteria: {
      title: "RedactionPolicy 模块与规则顺序",
      body: "## What to build\n\n建立 RedactionPolicy 模块。\n\n## Acceptance criteria\n\n- [ ] `src/policy.ts` 导出 RedactionPolicy\n- [ ] 顺序决策表覆盖 secret、PII、JWT\n",
    },
    // AI-Ops #670: no acceptance heading at all, four checkable steps.
    steps: {
      title: "[ticket] 终验 1.7.6：隔离 worktree + 两个 MCP server（建完即关）",
      body: "只取证，不改代码。把结果写进 commit body：\n\n1. `mcp__serena__find_symbol` 找 `ScopeContext` → relative_path 与行号\n2. 报出 `git rev-parse --show-toplevel` 的结果\n\n**不需要改任何产品代码。**\n",
    },
    // genesis-evidence #239: a PRD, by the same three headings planner.ts uses.
    prd: {
      title: "放开健康问题覆盖",
      body: "## Problem Statement\n\n报告里大量异常被丢弃。\n\n## Solution\n\n扩目录。\n\n## User Stories\n\n1. 作为用户我希望…\n",
    },
    // A research report — enough prose to be useful, and not an implementable
    // ticket. It must FAIL on the two rules it misses and not on a missing
    // heading, and the two advisory rules must NOT be what fails it.
    research: {
      title: "查到底：routing 为什么一直失败",
      body: "## 一句话\n\nJev 端点不可达。\n\n## 实测\n\n连续 401。\n\n## 要谁修\n\n运维。\n\n## 不是这条的东西\n\n前端显示问题。\n",
    },
    // AI-Ops #619's shape: everything a research report needs, plus an explicit
    // unresolved fork in its recommendations. This is the ticket that passed the
    // first version of this check, which is why the rule exists.
    undecided: {
      title: "security(公司侧): getOrderUserPage 在 user-id 为空时返回整租户订单",
      body: [
        "## 背景",
        "",
        "`getOrderUserPage` 只带一个 `tenant-id` 就能翻页取该租户所有订单。",
        "",
        "- 首选：**`user-id` 为空时不要返回任何行**（或在服务端从会话取身份）。",
        "- 次选：至少把它改成**必填**，缺参返回 400。",
        "",
        "- 本票**不改**公司仓库。",
      ].join("\n"),
    },
    // The same fork, waived — the waiver must not excuse it. A waiver names
    // where the CONTRACT lives; it cannot name which design to build.
    undecidedWaived: {
      title: "security(公司侧): getOrderUserPage 在 user-id 为空时返回整租户订单",
      body: "## 背景\n\n`getOrderUserPage` 的问题。\n\n- 首选：不返回任何行。\n- 次选：改成必填。\n\nNo-acceptance: 契约在 docs/security.md\n",
    },
    // A ZenTao ticket: a title, and nothing else.
    zentao: { title: "视频详情页面主图需要调整大小，增加主图框===泉哥（需出原型给开发，如抖音）", body: "" },
    // The waiver, which must be an assertion rather than silence.
    waived: { title: "按 docs/perf-baseline.md 收紧超时", body: "把 `src/net.ts` 的超时改为基线值。\n\nNo-acceptance: 数字来自 docs/perf-baseline.md\n" },
    // A stale acceptance heading — claims a weighing that never happened.
    hollow: { title: "调整 `src/app.ts` 启动顺序", body: "## Acceptance criteria\n\nTBD\n" },
    // No anchor: prose about a change with no location.
    anonchor: { title: "让系统更快", body: "## Acceptance criteria\n\n- [ ] 快 20%\n" },
    // An empty checkbox, WITH a valid anchor elsewhere in the body — the shape
    // that made the first version pass. The earlier fixture had no anchor, so it
    // failed the anchor rule and proved nothing about the acceptance rule.
    emptybullet: { title: "调整 `src/app.ts` 启动顺序", body: "改 `src/app.ts` 里的顺序。\n\n## Acceptance criteria\n\n- [ ]\n" },
    // A valid criterion list, then a note. The note is not a criterion, and a
    // section that swallows it answers "is there a criterion" from prose.
    noteAfterList: { title: "调整 `src/app.ts`", body: "改 `src/app.ts`。\n\n## Acceptance criteria\n\n- [ ] a.ts 行为变更已断言\n\n## Notes\n\n- 顺便看 `src/b.ts`。\n" },
    // ZenTao's `verify` beside a `spec` that has an EMPTY acceptance heading.
    // The field is the answer; the heading is not.
    zentaoVerify: { title: "需求名", body: "## Acceptance criteria\n", verify: "- [ ] 行为变更已断言" },
    // The same field written as PROSE, which is how people actually fill it in.
    // Inserting it verbatim left the ticket failing the rule the field exists to
    // answer, because the criteria rule wants list items.
    zentaoProse: { title: "需求名", body: "改 `app/report.py`。\n", verify: "报告显示更新后的数值" },
    // Placeholders: the bullet arm of `ITEM_RE` eats one content character, so
    // `- TBD` became `BD` and passed as a real criterion. Measured.
    placeholder: { title: "调整 `src/app.ts`", body: "改 `src/app.ts`。\n\n## Acceptance criteria\n\n- TBD\n" },
    placeholderCheckbox: { title: "调整 `src/app.ts`", body: "改 `src/app.ts`。\n\n## Acceptance criteria\n\n- [ ] TODO\n" },
    // A symbol inside ZenTao's `<code>` is the same anchor a markdown backtick
    // is, and stripping the tag lost it.
    zentaoCode: { title: "需求名", body: "<p>改 <code>ScopeContext</code></p>", verify: "行为变更已断言" },
  };

  expect("criteria passes", judge(F.criteria).ok, true);
  expect("checkable steps pass", judge(F.steps).ok, true);
  expect("a PRD passes", judge(F.prd).ok, true);
  expect("a PRD is reported as one", judge(F.prd).prd, true);
  expect("a research report fails", judge(F.research).ok, false);
  // ...and fails on the two rules it actually misses, not on a missing heading.
  const rf = judge(F.research).findings.filter((f) => f.level === "fail").map((f) => f.id).sort();
  expect("research report fails on acceptance+anchor", rf.join(","), "acceptance,anchor");
  expect("a title-only ticket fails", judge(F.zentao).ok, false);
  expect("a waiver passes", judge(F.waived).ok, true);
  expect("a waiver is recorded", judge(F.waived).waived, true);
  expect("a hollow section fails", judge(F.hollow).ok, false);
  expect("a missing anchor fails", judge(F.anonchor).ok, false);
  expect("an empty checkbox fails", judge(F.emptybullet).ok, false);
  // ...and the acceptance rule is what fails it. The earlier fixture failed on
  // the anchor too, so it could not tell the two apart.
  expect(
    "an empty checkbox fails on the acceptance rule",
    judge(F.emptybullet).findings.some((f) => f.id === "acceptance" && f.level === "fail"),
    true,
  );
  expect("a note after the list is a pass", judge(F.noteAfterList).ok, true);
  // Placeholders are not criteria, whatever marker they carry.
  expect("`- TBD` is not a criterion", judge(F.placeholder).ok, false);
  expect("`- [ ] TODO` is not a criterion", judge(F.placeholderCheckbox).ok, false);
  expect(
    "a placeholder fails on the acceptance rule",
    judge(F.placeholder).findings.some((f) => f.id === "acceptance" && f.level === "fail"),
    true,
  );
  // Prose `verify` is an answer; `<code>` is a code span. Both go through
  // `normalise` — that is where the `verify` mapping lives, and judging the raw
  // fixture would measure nothing (which is how the earlier `zentaoVerify`
  // fixture passed while its field was never read at all).
  expect("a prose `verify` is acceptance", judge(normalise(F.zentaoProse)).ok, true);
  expect("a `<code>` symbol is an anchor", judge(normalise(F.zentaoCode)).ok, true);
  expect("a prose `verify` is not left raw", judge(F.zentaoProse).ok, false);
  // Warnings must never decide the verdict, or the gate gets switched off.
  expect("warnings do not fail a ticket", judge(F.criteria).findings.some((f) => f.level === "warn"), true);
  // An unresolved fork is a failure, and a waiver does not cover it: the waiver
  // names where the contract lives, not which design to build.
  expect("an undecided ticket fails", judge(F.undecided).ok, false);
  expect(
    "the undecided ticket fails on the decision rule",
    judge(F.undecided).findings.some((f) => f.id === "undecided"),
    true,
  );
  expect("a waiver does not excuse an undecided ticket", judge(F.undecidedWaived).ok, false);
  expect("the waiver is still recorded", judge(F.undecidedWaived).waived, true);
  // ...and the rule is narrow: prose that merely mentions a preference is not a
  // fork. Without this, every ticket that says "首选" once would be blocked.
  expect(
    "a lone preference is not a fork",
    judge({ title: "调整 `src/a.ts`", body: "## Acceptance criteria\n\n- [ ] `src/a.ts` 用首选实现\n" }).ok,
    true,
  );

  // The ZenTao field mapping, which is the half a `body`-only parser gets wrong.
  const zt = ticketsFrom({ status: "success", data: [{ id: 9, name: "需求名", spec: "<p>改 <code>src/a.ts</code></p>", verify: "- [ ] a.ts 行为变更已断言" }] });
  expect("zentao `spec` is the body", zt[0].body.includes("src/a.ts"), true);
  expect("zentao HTML is stripped", /<p>/.test(zt[0].body), false);
  expect("zentao `verify` becomes acceptance", judge(zt[0]).ok, true);
  // `verify` filled in beside a `spec` that has an EMPTY acceptance heading —
  // the case a heading test discarded, because the heading was present.
  const ztEmpty = ticketsFrom({ data: [{ id: 10, name: "需求名", spec: "<p>改 <code>src/a.ts</code></p><h2>Acceptance criteria</h2>", verify: "- [ ] a.ts 行为变更已断言" }] });
  expect("zentao `verify` survives an empty heading in `spec`", judge(ztEmpty[0]).ok, true);

  // The manifest aggregation, driven through the same `ticketsFrom` + `judge`
  // path the CLI uses — not by counting strings in the output.
  const many = ticketsFrom({ data: [{ title: F.criteria.title, spec: F.criteria.body }, { title: F.zentao.title, spec: "" }] });
  expect("manifest counts every ticket", many.length, 2);
  expect("manifest counts passes", many.filter((t) => judge(t).ok).length, 1);
  // An empty list is a complete instruction on its own; an empty list WITH a
  // threshold is a gate that judged nothing. The two are not the same answer,
  // and the difference is the whole reason `--min-pass` exists.
  expect("an empty manifest judges nothing", ticketsFrom({ data: [] }).length, 0);

  // Negative controls. Each must turn a green assertion red — a self-check that
  // cannot fail is a self-check that proves nothing.
  const negations = [
    ["acceptance rule removed", (t) => judge({ ...t, body: t.body.replace(/^##+ *Acceptance criteria$/im, "## Notes") }), F.criteria, false],
    ["anchor rule removed", (t) => judge({ ...t, body: t.body.replace(/`src\/policy\.ts`/g, "那个模块") }), F.criteria, false],
    ["waiver ignored", (t) => judge({ ...t, body: t.body.replace("No-acceptance:", "Note:") }), F.waived, false],
  ];
  for (const [label, mutate, fixture, want] of negations) {
    expect(`negative control: ${label}`, mutate(fixture).ok, want);
  }

  if (failed > 0) {
    console.error(`ticket-check self-check failed (${failed})`);
    process.exit(1);
  }
  console.log("ticket-check self-check ok (acceptance by section/label/steps, PRD exempt, waiver, zentao fields, aggregation)");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

try {
  if (MANIFEST !== undefined) {
    const raw = MANIFEST === "-" || MANIFEST === "" ? readStdin() : readFileSync(MANIFEST, "utf8");
    const tickets = ticketsFrom(JSON.parse(raw));
    if (tickets.length === 0) {
      // An empty list with a threshold is a gate that judged nothing — the same
      // shape as an empty `--base`. Without a threshold it is just an empty
      // list, and reporting that is the honest answer.
      if (MIN_PASS_RAW !== undefined && MIN_PASS_RAW !== "") {
        console.error(
          "ticket check failed: the list is empty, so the threshold was never applied —\n" +
            "  a gate that judged nothing is not a passing gate. Widen the query, or drop\n" +
            "  `--min-pass` if an empty list is the expected result.",
        );
        process.exit(1);
      }
      console.log("ticket check: the list is empty — nothing to judge");
      process.exit(0);
    }
    let passed = 0;
    for (const t of tickets) {
      const r = reportOne(t);
      if (r.ok) passed++;
    }
    const ratio = passed / tickets.length;
    console.log("");
    console.log(`ticket check: ${passed}/${tickets.length} implementable (${Math.round(ratio * 100)}%)`);
    // A ratio is a policy number, not a fact — and one global threshold cannot
    // tell "these fourteen were all written too vaguely" from "these three are
    // blocked on a decision". ponytail: single global ratio, per-project
    // thresholds if a second repository needs a different bar.
    if (MIN_PASS_RAW !== undefined && MIN_PASS_RAW !== "") {
      const min = Number(MIN_PASS_RAW);
      if (!Number.isFinite(min) || min < 0 || min > 1) {
        console.error(`ticket check failed: --min-pass must be a ratio between 0 and 1, got \`${MIN_PASS_RAW}\``);
        process.exit(1);
      }
      if (ratio < min) {
        console.error(`ticket check failed: ${passed}/${tickets.length} implementable is below the required ${min}`);
        process.exit(1);
      }
    }
    process.exit(0);
  }

  if (EXPLICIT) {
    const tickets = [];
    if (JSON_MODE) {
      const raw = readStdin();
      if (!raw.trim()) {
        console.error("ticket check failed: `--json` was passed but stdin is empty — refusing to report success.");
        process.exit(1);
      }
      tickets.push(...ticketsFrom(JSON.parse(raw)));
    } else {
      const body = BODY_FILE !== undefined ? readFileSync(BODY_FILE, "utf8") : BODY ?? "";
      tickets.push(normalise({ title: TITLE ?? "", body }));
    }
    let bad = 0;
    for (const t of tickets) {
      const r = reportOne(t, { verbose: true });
      if (!r.ok) bad++;
    }
    process.exit(STRICT && bad > 0 ? 1 : 0);
  }

  // Bare invocation, no input: report the rules so the command is discoverable
  // and exits 0. There is nothing to gate, and there is nothing to judge.
  console.log(`ticket-check — is this ticket one an agent could finish?

  node .sandcastle/ticket-check.mjs --title "…" --body-file <path>
  node .sandcastle/ticket-check.mjs --json             < one-ticket.json
  node .sandcastle/ticket-check.mjs --manifest <path|-> [--min-pass 0.6]
  node .sandcastle/ticket-check.mjs --self-check

Add \`--strict\` to the first two to make them a gate: they report and exit 0
without it, so that reading a ticket never fails a shell. A misconfigured
\`--json\` with empty stdin fails either way — that is not a verdict, it is a
command that could not read its input.

Fails on:  no title · no body · no acceptance criteria (a heading, an inline
           label, a run of checkable steps, or a \`No-acceptance:\` line) ·
           acceptance section present but empty · no named file that changes.
Warns on:  no out-of-scope section · no problem statement. Warnings never
           change the exit code.
Passes:    a PRD (\`Problem Statement\` + \`Solution\` + \`User Stories\`, or a
           \`PRD\`/\`[spec]\` title) — it is implemented through its sub-issues.`);
} catch (error) {
  console.error(`ticket check could not read its input: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
