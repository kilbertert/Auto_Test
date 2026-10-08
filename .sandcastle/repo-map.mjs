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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = process.cwd();
const OUT = path.join(REPO, ".sandcastle", "REPO-MAP.md");
const args = process.argv.slice(2);

// Directories that are never part of the repository's shape: dependencies, build
// output, VCS metadata, tool caches. Matched by name at any depth.
const SKIP = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
  ".pytest_cache", ".ruff_cache", ".mypy_cache", ".next", ".turbo", "target",
  ".tox", "coverage", "htmlcov", ".cache",
  // Run residue, not repository shape: per-issue logs, worktrees, extracted
  // agent output. Listing them teaches the reader nothing and buries the source.
  "logs", "worktrees", "test-results", "playwright-report",
]);

// Bounded on purpose: a map that lists 4000 files is a directory listing, and
// the agent reads it as noise. These caps are the point of the tool.
const MAX_DEPTH = 2;
const MAX_ENTRIES_PER_DIR = 10;

function walk(dir, depth = 0) {
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
    if (e.isDirectory()) dirs.push({ name: e.name, path: full, children: walk(full, depth + 1) });
    else if (e.isFile()) files.push({ name: e.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
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

function entryPoints(root = REPO) {
  const found = [];
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
    if (fs.existsSync(path.join(root, c))) found.push(c);
  }
  return found;
}

function testLayout(root = REPO) {
  const found = [];
  for (const d of ["tests", "test", "frontend/e2e", "e2e", "spec", "__tests__"]) {
    const p = path.join(root, d);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    // Recursive, because a count that only sees the top level is wrong in the
    // direction that matters: `tests/unit/` would read as zero and the map would
    // tell the agent there is nothing to run. The count is of test-named files,
    // not of every file under the directory — conftest.py is neither.
    let n = 0;
    (function count(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
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
  if (fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    found.push("pytest (pyproject.toml / pytest.ini present)");
  }
  return found;
}

function docs() {
  const found = [];
  for (const f of ["GLOSSARY.md", "AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md"]) {
    if (fs.existsSync(path.join(REPO, f))) found.push(f);
  }
  for (const d of ["docs", "docs/adr", "docs/agents"]) {
    const p = path.join(REPO, d);
    if (!fs.existsSync(p)) continue;
    const n = fs.readdirSync(p).filter((e) => e.endsWith(".md")).length;
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
  const lines = [
    "# Repository map",
    "",
    "<!-- Generated by .sandcastle/repo-map.mjs — do not edit by hand.",
    "     Regenerate: node .sandcastle/repo-map.mjs",
    "     This file is mechanical: it reports what the filesystem and the manifest",
    "     say. It does not describe architecture or intent — for those, read the",
    "     code and GLOSSARY.md. -->",
    "",
    "Read this before exploring by hand. It answers where things are; it does not",
    "answer how they work.",
    "",
    "It is generated from the filesystem as it stands in this checkout, not from",
    "the set of tracked files — so an untracked directory outside the generator's",
    "skip list changes the map, and `repo-map.check.mjs` will ask for a",
    "regeneration. That is deliberate: an agent works in a checkout, and a mount",
    "point or a stray `output/` is part of what it sees.",
    "",
    "## Entry points",
    "",
  ];
  const ep = entryPoints();
  lines.push(...(ep.length ? ep.map((e) => `- ${e}`) : ["- (none detected — check the manifest and README)"]));

  lines.push("", "## Tests", "");
  const tl = testLayout();
  lines.push(...(tl.length ? tl.map((t) => `- ${t}`) : ["- (none detected)"]));

  lines.push("", "## Docs", "");
  const dc = docs();
  lines.push(...(dc.length ? dc.map((d) => `- ${d}`) : ["- (none detected)"]));

  lines.push(
    "",
    `## Tree (depth ${MAX_DEPTH}, first ${MAX_TREE_LINES} lines; dependencies, build`,
    "output and run residue omitted)",
    "",
    "```",
  );
  const tree = treeLines(walk(REPO));
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
  if (failures > 0) {
    console.error(`repo-map self-check failed (${failures})`);
    process.exit(1);
  }
  console.log("repo-map self-check ok (pyproject parser, entry-point filter, test count)");
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

