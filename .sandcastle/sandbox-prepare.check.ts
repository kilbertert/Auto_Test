/**
 * Runnable regression check for the sandbox prepare hook.
 *
 * Run: `npx tsx .sandcastle/sandbox-prepare.check.ts`
 *
 * The hook decides whether a run's workspace is set up before the agent starts.
 * Its failure mode is silent in both directions:
 *
 *   - wired-but-broken: the hook names a script that is not there, or an
 *     absolute path the provider does not mount — sandcastle runs the command
 *     and the run dies with an exec error that reads like an agent failure;
 *   - never-wired: the file exists, nobody registered it, and every run silently
 *     goes back to the agent installing its own dependencies — which is the
 *     behaviour this hook exists to remove, and it looks like a slow agent
 *     rather than a missing hook.
 *
 * So this asserts the pairing, not either half: the script exists AND the hook
 * points at it, or neither is true.
 */
import { existsSync, readFileSync } from "node:fs";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`sandbox-prepare check failed: ${message}`);
}

const profile = readFileSync(new URL("./profile.ts", import.meta.url), "utf8");
const scriptPath = new URL("./sandbox-prepare.sh", import.meta.url);
const scriptExists = existsSync(scriptPath);

// --- the two halves agree ----------------------------------------------------
//
// `existsSync(join(process.cwd(), PREPARE_SCRIPT))` is the gate: the hook is
// registered only when the file is present at run time. Asserting the gate's
// spelling matters because `PREPARE_SCRIPT` is built from a `join` — a path that
// resolves one directory off would register the hook for every project and fail
// inside the sandbox instead of here.
assert(
  profile.includes('const PREPARE_SCRIPT = join(".sandcastle", "sandbox-prepare.sh")'),
  "profile.ts must build the prepare path as .sandcastle/sandbox-prepare.sh",
);
assert(
  profile.includes("existsSync(join(process.cwd(), PREPARE_SCRIPT))"),
  "profile.ts must gate the hook on the script existing at run time",
);

if (scriptExists) {
  assert(
    profile.includes("hooks:") && profile.includes("onSandboxReady"),
    "the prepare script exists but profile.ts registers no onSandboxReady hook — it would never run",
  );
  // The command is relative on purpose: sandcastle runs a sandbox hook with cwd
  // set to the repository root. An absolute path would hard-code a provider
  // constant this scaffold does not own, and a provider change would break it
  // with no signal here.
  assert(
    profile.includes('command: "bash .sandcastle/sandbox-prepare.sh"'),
    "the hook command must be the relative path — sandcastle sets cwd to the repo root",
  );
  // A generated skill or a future edit that puts a path with a leading slash in
  // the command is the failure this catches: it looks more explicit and is wrong.
  const command = profile.match(/command: "([^"]*sandbox-prepare[^"]*)"/)?.[1] ?? "";
  assert(
    !command.startsWith("/"),
    `the hook command must not be absolute, got: ${command}`,
  );
}

const script = scriptExists ? readFileSync(scriptPath, "utf8") : "";
if (scriptExists) {
  // It runs unattended, once per iteration, with no one to answer. `-e` so a
  // failing setup step fails the run rather than letting the agent proceed
  // against a half-built workspace.
  assert(script.includes("set -euo pipefail"), "the prepare script must fail fast (set -euo pipefail)");
  // Idempotent is a requirement, not a nicety: sandcastle runs the hook for
  // every iteration of a run, so a script that appends or re-downloads will do
  // it N times.
  assert(
    /idempotent/i.test(script),
    "the prepare script's own documentation must state the idempotence requirement",
  );
}

console.log(
  `sandbox-prepare check ok (script ${scriptExists ? "present, hook wired" : "absent, hook off"})`,
);
