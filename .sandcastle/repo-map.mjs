#!/usr/bin/env node
/**
 * Generate `.sandcastle/REPO-MAP.md` — the repository map an agent reads before
 * exploring by hand.
 *
 * Why this exists: measured on a real AFK run (health-flow #114), the agent spent
 * 36 of its 62 tool calls on `cat`/`ls`/`grep`/`sed` — locating entry points, test
 * layout, and docs. A map that already answers those costs one file read and
 * leaves the tool budget for the task.
 *
 * Deliberately mechanical: it reports what the filesystem and the manifest
 * already say, and never guesses at architecture. A map that speculates is worse
 * than no map, because it is read with the same confidence as the code.
 *
 * Usage:
 *   node .sandcastle/repo-map.mjs            # write .sandcastle/REPO-MAP.md
 *   node .sandcastle/repo-map.mjs --stdout   # print, write nothing
 *   node .sandcastle/repo-map.mjs --check    # exit 1 if the file is stale
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = process.cwd();
const OUT = path.join(REPO, ".sandcastle", "REPO-MAP.md");
const args = process.argv.slice(2);

// ── what counts as "the repository" ──────────────────────────────────────────
//
// The file set comes from git, not from a filesystem walk. That is a correction,
// not a preference: a walk answers "what is on this disk right now", which is a
// different question in every checkout. Measured across the four projects on this
// host, the same commit produced a different map locally and on CI, because the
// working copies carry build residue (`artifacts/`, `dist/`, `mutants/`,
// `.venv/` scopes, local databases) that a CI checkout does not have. The
// freshness check then reported `stale` locally and `ok` on CI for one commit —
// the check disagreed with itself depending on where it ran, which makes it
// noise rather than a signal.
//
// The git view is defined by the repository rather than by the disk:
//
//   - tracked files, plus untracked-and-not-ignored ones, so a file bootstrap or
//     the agent has just written but not yet committed is inside the map (those
//     call sites generate it before the commit exists);
//   - everything `.gitignore` names is outside it. That is what the ignore file
//     is *for*, and both environments read the same one, so they agree.
//
// The residual disagreement is a stray unignored file, which genuinely belongs to
// the repository and should be committed — failing the check there is correct.
//
// The SKIP set stays, now doing one job instead of two: it bounds which *directories*
// of that set are worth descending into. `node_modules` and friends are on it by
// name, so an unignored copy in a fresh clone would not drag thousands of lines in.
const SKIP = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
  ".pytest_cache", ".ruff_cache", ".mypy_cache", ".next", ".turbo", "target",
  ".tox", "coverage", "htmlcov", ".cache",
  // Run residue, not repository shape: per-issue logs, worktrees, extracted
  // agent output. Listing them teaches the reader nothing and buries the source.
  "logs", "worktrees", "test-results", "playwright-report",
]);

/** Paths git considers part of this repository, relative to the root, POSIX-separated. */
function trackedPaths(root) {
  try {
    const out = execFileSync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      // stderr is dropped: "not a git repository" is the expected answer for a
      // project that is not one, not something to print on every generation.
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    return new Set(out.split("\0").filter((p) => p !== ""));
  } catch {
    // No git, no repository, or git unavailable. `null` means "unknown", and the
    // callers fall back to the filesystem — the same behaviour as before, and a
    // map that is right about the tracked files plus whatever else is on disk.
    return null;
  }
}

// Bounded on purpose: a map that lists 4000 files is a directory listing, and
// the agent reads it as noise. These caps are the point of the tool.
const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 10;

function walk(dir, root = REPO, tracked = null, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".") && e.name !== ".sandcastle") continue;
    const full = path.join(dir, e.name);
    const relPath = path.relative(root, full).split(path.sep).join("/");
    if (tracked) {
      // A directory is worth descending into only if git knows about something
      // inside it; a file is part of the map only if it is. Both are the same
      // question — "does this path prefix any tracked entry" — asked of different
      // depths, so one predicate answers it either way.
      const known = e.isDirectory() ? hasChild(tracked, relPath) : tracked.has(relPath);
      if (!known) continue;
    }
    if (e.isDirectory()) dirs.push({ name: e.name, path: full, children: walk(full, root, tracked, depth + 1) });
    else if (e.isFile()) files.push({ name: e.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/** Does any tracked path live under `prefix/`? */
function hasChild(tracked, prefix) {
  const needle = `${prefix}/`;
  for (const p of tracked) if (p.startsWith(needle)) return true;
  return false;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function rel(p) {
  return path.relative(REPO, p) || ".";
}

// `[project.scripts]` out of a pyproject.toml, without a TOML parser.
//
// A table of `name = "module:function"` is the Python equivalent of package.json
// scripts, and for a project that ships console commands it *is* the entry-point
// answer — genesis-evidence exposes four, and a map that listed only the `afk`
// script sent the agent looking for a service it had just been told did not
// exist. Comments and inline tables are dropped; anything unparseable is
// skipped rather than guessed at, because a map that speculates is read with the
// same confidence as the code.
function readPyprojectScripts(root = REPO) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8");
  } catch {
    return [];
  }
  const found = [];
  let inScripts = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) {
      // The section ends at the next table header, at any level. Comparing the
      // trimmed string rather than parsing the header keeps `[[…]]` array tables
      // from reading as a continuation of this one.
      inScripts = line === "[project.scripts]";
      continue;
    }
    if (!inScripts) continue;
    const m = /^([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (m) found.push(`console script "${m[1]}": ${m[2]} (pyproject.toml)`);
  }
  return found;
}

// ── the four questions the measured run asked, answered from the filesystem ──

function entryPoints(root = REPO, tracked = null) {
  const found = [];
  const present = (rel) => (tracked ? tracked.has(rel) : fs.existsSync(path.join(root, rel)));
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    for (const candidate of ["main", "module", "exports"]) {
      if (typeof pkg[candidate] === "string") found.push(`${candidate}: ${pkg[candidate]} (package.json)`);
    }
    // Every script whose command runs a file is an entry point the agent may
    // need. The allowlist this replaced named five (dev/start/serve/afk/ralph)
    // and silently dropped the rest — on one project that meant `easy`, its main
    // user CLI, was absent from a map whose whole job is to say where things are.
    // A map that lists only the harness's own entry points is worse than a short
    // one: the reader concludes the others do not exist.
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      // Scripts that only delegate (`npm run x && npm run y`) or only invoke a
      // tool (`vitest run`, `tsc -p .`) are not files a reader can open.
      if (/(?:^|\s)(?:npm|pnpm|yarn|npx|tsc|vitest|jest|eslint|ruff|pytest|make)\b/.test(cmd)) continue;
      if (/^(?:node|tsx|ts-node|bun|deno)\s/.test(cmd) || /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rb|sh)\b/.test(cmd)) {
        found.push(`script "${name}": ${cmd} (package.json)`);
      }
    }
  }
  found.push(...readPyprojectScripts(root));
  // Conventional entry points, checked rather than assumed.
  for (const c of [
    "app/main.py", "main.py", "src/main.py", "manage.py",
    "frontend/src/main.jsx", "frontend/src/main.tsx", "src/main.tsx", "src/main.ts", "src/index.js",
    "cmd/main.go", "main.go",
  ]) {
    if (present(c)) found.push(c);
  }
  return found;
}

function testLayout(root = REPO, tracked = null) {
  const found = [];
  const present = (rel) => (tracked ? tracked.has(rel) : fs.existsSync(path.join(root, rel)));
  const isDir = (rel) => (tracked ? hasChild(tracked, rel) : fs.existsSync(path.join(root, rel)));
  for (const d of ["tests", "test", "frontend/e2e", "e2e", "spec", "__tests__"]) {
    const p = path.join(root, d);
    if (!isDir(d) || (!tracked && !fs.statSync(p).isDirectory())) continue;
    // Recursive, because a count that only sees the top level is wrong in the
    // direction that matters: `tests/unit/` would read as zero and the map would
    // tell the agent there is nothing to run. The count is of test-named files,
    // not of every file under the directory — conftest.py is neither.
    let n = 0;
    (function count(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const relPath = path.relative(root, full).split(path.sep).join("/");
        if (tracked && !(e.isDirectory() ? hasChild(tracked, relPath) : tracked.has(relPath))) continue;
        if (e.isDirectory()) count(full);
        else if (/(^test[_-]|_test\.|\.test\.|\.spec\.)/.test(e.name)) n += 1;
      }
    })(p);
    found.push(`${d}/ — ${n} test file(s, recursive)`);
  }
  const pkg = readJson(path.join(root, "package.json"));
  for (const [name, cmd] of Object.entries(pkg?.scripts ?? {})) {
    if (/test|check|lint|typecheck/.test(name)) found.push(`script "${name}": ${cmd}`);
  }
  // Presence, not `readJson`: `pyproject.toml` is TOML, so parsing it as JSON
  // always failed and the second half of this test never fired. The file
  // existing is the whole signal — a project carrying a pyproject.toml runs
  // pytest through it or through a pytest.ini beside it.
  if (present("pytest.ini") || present("pyproject.toml")) {
    found.push("pytest (pyproject.toml / pytest.ini present)");
  }
  return found;
}

function docs(tracked = null) {
  const found = [];
  const present = (rel) => (tracked ? tracked.has(rel) : fs.existsSync(path.join(REPO, rel)));
  for (const f of ["GLOSSARY.md", "AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md"]) {
    if (present(f)) found.push(f);
  }
  for (const d of ["docs", "docs/adr", "docs/agents"]) {
    const p = path.join(REPO, d);
    if (!present(p) && !(tracked && hasChild(tracked, d))) continue;
    // Counted from the same set the tree is built from, so a residue directory
    // cannot inflate the number the reader is given.
    const n = tracked
      ? [...tracked].filter((x) => x.startsWith(`${d}/`) && x.endsWith(".md")).length
      : fs.readdirSync(p).filter((e) => e.endsWith(".md")).length;
    found.push(`${d}/ — ${n} markdown file(s)`);
  }
  return found;
}

// The tree is bounded twice: per directory, and in total. A map that grows with
// the repository is a directory listing, and the reader pays for every line —
// measured at depth 3 this reached 452 lines for one mid-sized project, which is
// the cost this tool exists to avoid.
const MAX_TREE_LINES = 80;

// Directories whose contents the reader does not need spelled out. `.sandcastle`
// is the scaffold this tool ships in: an agent reading the map is looking for the
// *project's* shape, and listing the harness's own files spends the whole budget
// on the part it does not work in.
const COLLAPSE = new Set([".sandcastle"]);

function treeLines(nodes, depth = 0) {
  const pad = "  ".repeat(depth);
  const out = [];
  let shown = 0;
  for (const n of nodes) {
    if (out.length >= MAX_TREE_LINES) return out;
    if (shown >= MAX_ENTRIES_PER_DIR) {
      out.push(`${pad}... (${nodes.length - shown} more)`);
      break;
    }
    if (n.children !== undefined) {
      out.push(COLLAPSE.has(n.name) ? `${pad}${n.name}/  (the AFK scaffold — see its README)` : `${pad}${n.name}/`);
      if (!COLLAPSE.has(n.name)) out.push(...treeLines(n.children, depth + 1));
    } else {
      out.push(`${pad}${n.name}`);
    }
    shown += 1;
  }
  return out;
}

function render() {
  const tracked = trackedPaths(REPO);
  const lines = [
    "# Repository map",
    "",
    "<!-- Generated by .sandcastle/repo-map.mjs — do not edit by hand.",
    "     Regenerate: node .sandcastle/repo-map.mjs",
    "     This file is mechanical: it reports what git tracks and what the manifest",
    "     says. It does not describe architecture or intent — for those, read the",
    "     code and GLOSSARY.md. -->",
    "",
    "Read this before exploring by hand. It answers where things are; it does not",
    "answer how they work.",
    "",
    // The provenance line is derived, not asserted: a static "generated from git"
    // would be false in the one case where git is unavailable and the generator
    // fell back to the filesystem. A map that misstates its own inputs is read
    // with the same confidence as one that misstates its contents.
    ...(tracked
      ? [
          "It is generated from **git's view of the repository** — tracked files, plus",
          "untracked ones that `.gitignore` does not exclude. Build residue, local",
          "databases and caches are outside it by definition, which is what makes the",
          "map the same in a working copy and in CI: the same `.gitignore` decides both.",
          "A file you have written but not committed is still inside it, so the map is",
          "accurate at the moment it is generated and at the moment the commit lands.",
        ]
      : [
          "It is generated from the **filesystem**, because git is unavailable here or",
          "this is not a repository. Build residue and local caches are inside it, so",
          "the map can differ between two checkouts of the same commit — `.gitignore`",
          "is the fix, when git is available.",
        ]),
    "",
    "## Entry points",
    "",
  ];
  const ep = entryPoints(REPO, tracked);
  lines.push(...(ep.length ? ep.map((e) => `- ${e}`) : ["- (none detected — check the manifest and README)"]));

  lines.push("", "## Tests", "");
  const tl = testLayout(REPO, tracked);
  lines.push(...(tl.length ? tl.map((t) => `- ${t}`) : ["- (none detected)"]));

  lines.push("", "## Docs", "");
  const dc = docs(tracked);
  lines.push(...(dc.length ? dc.map((d) => `- ${d}`) : ["- (none detected)"]));

  lines.push(
    "",
    `## Tree (depth ${MAX_DEPTH}, first ${MAX_TREE_LINES} lines; dependencies, build`,
    "output and run residue omitted)",
    "",
    "```",
  );
  const tree = treeLines(walk(REPO, REPO, tracked));
  lines.push(...tree);
  if (tree.length >= MAX_TREE_LINES) lines.push("... (truncated — list the rest with `ls`/`find`)");
  lines.push("```", "");

  return lines.join("\n");
}

// Self-check: the parser is the part that can be silently wrong. A regex that
// matches nothing produces a map that looks complete and omits the answer — the
// failure mode this whole file exists to avoid, and the one a fresh scaffold
// cannot catch because a fresh scaffold has no console scripts.
//
// Run: `node .sandcastle/repo-map.mjs --self-check`
if (args.includes("--self-check")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-map-selfcheck-"));
  const cases = [
    ['[project.scripts]\nserve = "pkg.serve:main"\n', 1, "a plain table"],
    [
      '[project]\nname = "x"\n\n[project.scripts]\nserve = "pkg.serve:main"\n# comment\nworker="pkg.w:go"\n\n[tool.ruff]\nline-length = 100\n',
      2,
      "two entries, a comment, and a following table",
    ],
    ['[project]\nname = "x"\n', 0, "no scripts table"],
    ['[project.scripts]\n"quoted" = "pkg.x:main"\n', 0, "a quoted key is not a console script"],
    ['[[tool.x]]\nserve = "pkg.serve:main"\n', 0, "an array table is not the scripts table"],
  ];
  let failures = 0;
  for (const [body, expected, label] of cases) {
    fs.writeFileSync(path.join(dir, "pyproject.toml"), body);
    const got = readPyprojectScripts(dir);
    if (got.length !== expected) {
      console.error(`  ${label}: expected ${expected}, got ${got.length}`);
      failures += 1;
    }
  }
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project.scripts]\nserve = "pkg.serve:main"\n');
  // Through entryPoints, not the parser: a parser that is right while the call
  // that uses it is commented out passes a parser-only check and ships a map
  // with no entry points in it. That is the failure this file exists to prevent.
  const text = entryPoints(dir).find((l) => l.includes("serve")) ?? "";
  if (!text.includes('"serve"') || !text.includes("pkg.serve:main")) {
    console.error(`  the entry must name both the command and its target, got: ${text}`);
    failures += 1;
  }
  // A missing file is not an error: most projects here have no pyproject.toml,
  // and a generator that threw on one would fail every Node-only project.
  const emptyDir = path.join(dir, "no-manifest-here");
  fs.mkdirSync(emptyDir);
  if (readPyprojectScripts(emptyDir).length !== 0) {
    console.error("  a directory without pyproject.toml must yield no entry points");
    failures += 1;
  }
  // package.json scripts, and the reason this self-check is not parser-only: the
  // filter decides what the agent is told exists, and a filter that is too narrow
  // fails *quietly*. The allowlist this replaced named five script names, so on a
  // project whose main CLI was called something else the map simply did not
  // mention it — the agent then concludes it does not exist.
  fs.rmSync(path.join(dir, "pyproject.toml"), { force: true });
  const scripts = {
    "user-cli": "tsx src/cli/easy.ts",
    "agent:thing": "node src/cli/agent-test.js",
    dev: "vite",
    start: "node dist/index.js",
    check: "npm run typecheck && npm run test",
    test: "vitest run",
    build: "tsc -p tsconfig.json",
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  const entries = entryPoints(dir);
  const has = (name) => entries.some((e) => e.startsWith(`script "${name}":`));
  for (const [name, expected, why] of [
    ["user-cli", true, "a script running a .ts file is an entry point"],
    ["agent:thing", true, "so is one running a .js file"],
    ["start", true, "so is one running a built file"],
    ["dev", false, "a bare tool invocation is not a file a reader can open"],
    ["test", false, "neither is a test runner"],
    ["build", false, "nor a compiler"],
    ["check", false, "nor a delegating script"],
  ]) {
    if (has(name) !== expected) {
      console.error(`  package.json script "${name}": expected ${expected ? "in" : "out"} of the map`);
      failures += 1;
      void why;
    }
  }

  // The test count is recursive, because a map that reports `tests/ — 0 test
  // files` for a project whose tests all live one level down is worse than no
  // count at all: it tells the agent there is nothing to run.
  const testDir = path.join(dir, "tests", "unit");
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, "test_alpha.py"), "");
  fs.writeFileSync(path.join(testDir, "helper_test.py"), "");
  fs.writeFileSync(path.join(testDir, "definitely.py"), "");
  fs.writeFileSync(path.join(dir, "tests", "conftest.py"), "");
  const line = testLayout(dir).find((l) => l.startsWith("tests/")) ?? "";
  if (!/2 test file\(s/.test(line)) {
    console.error(`  the test count must see files one level down and count only test-named ones, got: ${line || "(none)"}`);
    failures += 1;
  }
  fs.rmSync(testDir, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });

  // The file set is the correction this version is about, so it gets its own
  // fixture: a repository with one tracked file, one untracked-and-ignored
  // directory, and one untracked-not-ignored file. The first two must be outside
  // the map and the third inside it — that is the whole rule, stated as a test.
  const repoDir = path.join(dir, "as-a-repo");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "build-output-xyz"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "kept.ts"), "");
  fs.writeFileSync(path.join(repoDir, "build-output-xyz", "built.bin"), "");
  fs.writeFileSync(path.join(repoDir, "notes", "loose.md"), "");
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "build-output-xyz/\n");
  const git = (a) => execFileSync("git", ["-C", repoDir, ...a], { stdio: "pipe" });
  git(["init", "-q"]);
  git(["add", "src/kept.ts", ".gitignore"]);
  const set = trackedPaths(repoDir);
  if (set === null) {
    console.error("  trackedPaths returned null for a real repository");
    failures += 1;
  } else {
    for (const [p, expected] of [
      ["src/kept.ts", true, "a tracked file is in the map"],
      ["notes/loose.md", true, "an untracked, unignored file is in the map — bootstrap writes before committing"],
      ["build-output-xyz/built.bin", false, "an ignored file is outside the map"],
    ]) {
      if (set.has(p) !== expected) {
        console.error(`  ${p}: expected ${expected ? "inside" : "outside"} the map`);
        failures += 1;
      }
    }
    // Through the *shipped pipeline*, not through `walk` directly. A file set
    // that is right while `render` ignores it passes a unit-level check and ships
    // a map built the old way — which is the exact defect this version fixes, so
    // the assertion has to see the whole path. The generator is re-entered as a
    // subprocess with the fixture as its working directory, which is also how it
    // is used in the field.
    const map = execFileSync(process.execPath, [process.argv[1], "--stdout"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    // Only the Tree section: the footer says "run residue omitted", and a
    // substring test for that word matched the generator's own prose rather than
    // the directory. A marker that cannot appear in the boilerplate is the fix.
    const treeSection = map.slice(map.indexOf("## Tree"));
    if (treeSection.includes("build-output-xyz")) {
      console.error(`  the ignored directory appears in the generated map:\n${treeSection}`);
      failures += 1;
    }
    if (!treeSection.includes("notes")) {
      console.error(`  an unignored untracked file is missing from the generated map:\n${treeSection}`);
      failures += 1;
    }
    if (!treeSection.includes("kept.ts")) {
      console.error(`  a tracked file is missing from the generated map:\n${treeSection}`);
      failures += 1;
    }
  }
  fs.rmSync(repoDir, { recursive: true, force: true });

  // One gate, at the end. An earlier version had it before the last assertion
  // block, so failures counted there were reported as `ok` and the process
  // exited 0 — a check that could not fail, which is worse than no check.
  if (failures > 0) {
    console.error(`repo-map self-check failed (${failures})`);
    process.exit(1);
  }
  console.log("repo-map self-check ok (pyproject parser, entry-point filter, test count, git file set)");
  process.exit(0);
}

const rendered = render();

if (args.includes("--stdout")) {
  process.stdout.write(rendered);
} else if (args.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== rendered) {
    console.error("REPO-MAP.md is stale — regenerate: node .sandcastle/repo-map.mjs");
    process.exit(1);
  }
  console.log("REPO-MAP.md is current");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rendered);
  console.log(`wrote ${rel(OUT)} (${rendered.split("\n").length} lines)`);
}

