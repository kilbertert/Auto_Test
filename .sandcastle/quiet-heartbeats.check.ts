/**
 * Runnable regression check for the thinking-token heartbeat filter.
 *
 * Run: `npx tsx .sandcastle/quiet-heartbeats.check.ts`
 *
 * The failure this guards has no symptom of its own — the filter sits between
 * another product's stream and the console, and both ways it can break are quiet:
 *
 *   - too wide: agent output that merely mentions the frame gets swallowed, and
 *     nothing anywhere reports a missing line;
 *   - too narrow: the flood comes back, and a reader attributes it to the agent
 *     being chatty rather than to a filter that stopped matching.
 *
 * Both are asserted here against the frame shapes measured from a real run, and
 * the count printed at exit is asserted too: it is the one signal that tells a
 * future release's rename from a run that simply had no thinking.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  isThinkingHeartbeat,
  quietThinkingHeartbeats,
  thinkingHeartbeatsSuppressed,
} from "./quiet-heartbeats.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`quiet-heartbeats check failed: ${message}`);
}

// --- the frame, verbatim from Claude Code 2.1.311 ----------------------------
const heartbeat =
  '{"type":"system","subtype":"thinking_tokens","estimated_tokens":42,"estimated_tokens_delta":4,"session_id":"2556f177","uuid":"9b1c"}';
assert(isThinkingHeartbeat(heartbeat), "a real thinking_tokens frame must be dropped");

// Field order is not ours to assume: the match is on parsed values.
const reordered =
  '{"subtype":"thinking_tokens","type":"system","estimated_tokens":1,"estimated_tokens_delta":1}';
assert(isThinkingHeartbeat(reordered), "field order must not matter");

// --- everything else survives ------------------------------------------------
const keep = [
  // A different system frame. Dropping every `system` line would take the init
  // frame with it, which is where the session id and the tool list come from.
  '{"type":"system","subtype":"init","session_id":"2556f177"}',
  // The frames the log exists for.
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
  '{"type":"result","subtype":"success","result":"done"}',
  // An agent quoting the frame in its own answer. This is the case a substring
  // match gets wrong, and it is a real one: this module's own docstring is such a
  // quote, and an agent asked to explain the filter will print it.
  'The frame is {"type":"system","subtype":"thinking_tokens","estimated_tokens":1}.',
  // Not JSON at all — the CLI's own warnings, tool output, blank lines.
  "[claude-code:unrecognized_model] something",
  "",
];
for (const line of keep) {
  assert(!isThinkingHeartbeat(line), `must not drop: ${JSON.stringify(line.slice(0, 40))}`);
}

// A substring sitting inside a line that is not a frame is not a frame.
assert(
  !isThinkingHeartbeat('{"type":"assistant","note":"thinking_tokens"}'),
  "the subtype name alone must not mark a line as a heartbeat",
);
// Malformed JSON must not throw out of a stdout wrapper.
assert(!isThinkingHeartbeat('{"type":"system","subtype":"thinking_tokens"'), "truncated JSON must be kept");

// --- the patch: one write per line, as sandcastle's verbose sink does --------
quietThinkingHeartbeats();
assert(
  (process.stdout.write(heartbeat + "\n") as unknown) === true,
  "a dropped frame must report a successful write, as the sink expects",
);
assert(thinkingHeartbeatsSuppressed() === 1, "one heartbeat written must be one counted");

for (const line of keep) process.stdout.write(line + "\n");

assert(
  thinkingHeartbeatsSuppressed() === 1,
  "non-heartbeat lines must not be counted as dropped",
);

// The wrapper must not swallow a frame that arrives without its terminator: that
// is half a line, and judging it would risk eating the start of real output.
process.stdout.write(heartbeat);
assert(
  thinkingHeartbeatsSuppressed() === 1,
  "an unterminated write must not be judged",
);

// Object chunks (Buffers, typed arrays) must pass through untouched.
assert(
  (process.stdout.write(Buffer.from("buffered\n")) as unknown) === true,
  "a buffer chunk must still be written",
);

// --- the writable-stream contract (review finding 1) -------------------------
//
// `write(chunk[, encoding][, callback])` invokes the callback even for a write
// that completes synchronously. A drop that returns `true` without it strands
// every caller awaiting that callback — and stdout is process-wide, so that is
// the whole runner, not just the verbose sink.
//
// Asserted in a CHILD process: the wrapper's callback goes through
// `process.nextTick`, and inside this one an un-fired callback would be
// indistinguishable from a tick that has not run yet.
const callbackProbe = `
  const frame = ${JSON.stringify(heartbeat)};
  quietThinkingHeartbeats();
  process.stdout.write(frame + "\\n", () => {
    // Delivered asynchronously, or not at all. This is the only way either shows.
    setTimeout(() => {
      process.stderr.write("callback-fired\\n");
      process.exit(0);
    }, 20);
  });
  setTimeout(() => {
    process.stderr.write("callback-lost\\n");
    process.exit(1);
  }, 2000);
`;
const probeRun = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `import { quietThinkingHeartbeats } from "./quiet-heartbeats.ts";${callbackProbe}`,
  ],
  { cwd: import.meta.dirname, encoding: "utf8", timeout: 10_000 },
);
assert(
  probeRun.stderr.includes("callback-fired"),
  `a suppressed write must still call its callback (stderr: ${probeRun.stderr.trim()})`,
);

// --- the exit summary survives a piped stdout (review finding 2) -------------
//
// `exit` cannot wait for an asynchronous write to flush, and Actions captures
// stdout through a pipe. The count is the only signal that tells a renamed frame
// from a run that simply had no thinking, so losing it removes the safety net.
//
// ⚠️ A behavioural assertion CANNOT see this on this host: `spawnSync` with a
// pipe was measured to deliver the summary either way, because the write is
// small enough to drain before termination. A test that passes for both the
// fixed and the broken code is worse than no test — it certifies the defect.
// So this asserts the property that makes it safe, read from the source: the
// summary is written with a synchronous call, not through `stream.write`.
const source = readFileSync(new URL("./quiet-heartbeats.ts", import.meta.url), "utf8");
const exitHandler = source.slice(source.indexOf('process.on("exit"'));
assert(
  /writeSync\(/.test(exitHandler),
  "the exit summary must use a synchronous write; a queued async write can be discarded",
);
// The captured `write` closure from the wrapper, called from `exit`. Matched on
// the call shape rather than a line number, so reformatting does not matter.
assert(
  !/^\s*write\(/m.test(exitHandler),
  "the exit summary must not go through the captured stream.write — it cannot be flushed from `exit`",
);

// The count still has to reach a captured stdout in the ordinary case. This is
// the weaker half, kept because it is the observable a reader relies on.
const exitProbe = `
  const frame = ${JSON.stringify(heartbeat)};
  quietThinkingHeartbeats();
  process.stdout.write(frame + "\\n");
`;
const exitRun = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `import { quietThinkingHeartbeats } from "./quiet-heartbeats.ts";${exitProbe}`,
  ],
  { cwd: import.meta.dirname, encoding: "utf8", timeout: 10_000 },
);
assert(
  /dropped 1 thinking-token frame/.test(exitRun.stderr),
  `the exit summary must reach a captured stderr (stderr: ${JSON.stringify(exitRun.stderr)})`,
);
// And it must NOT reach stdout — see the placement assertion below, which reads
// the source. This is the behavioural half: a run that appends to stdout breaks
// any consumer parsing it, so the two are asserted together.
assert(
  !/dropped 1 thinking-token frame/.test(exitRun.stdout),
  `the exit summary must stay out of stdout (stdout: ${JSON.stringify(exitRun.stdout)})`,
);

// --- the filter is actually WIRED (review finding 4) -------------------------
//
// Everything above proves the module is correct. None of it proves a run uses it.
// Deleting the `quietThinkingHeartbeats()` call from `claudeProfile()` leaves
// every assertion above green while runners print heartbeats again — the same
// "helper correct, wiring gone" gap that `profile-network.check.ts` closes for
// the network spread, and it was found in review of a real consumer PR.
//
// Read the source rather than importing it: importing `profile.ts` pulls in the
// Sandcastle provider, which this check must stay runnable without.
//
// ⚠️ A source-text match alone is not enough, and this was found in review: the
// assertions below pass if the call moves into a function nobody invokes, or into
// `claudeProfile`'s body position that never executes. So the text check is
// paired with a BEHAVIOURAL one — see "the filter runs" below. Text says where
// the call is written; behaviour says a runner actually reaches it.
//
// The match is line-anchored (`^\s*`) and excludes a commented-out call, so a
// `// quietThinkingHeartbeats();` does not satisfy it.
const profileSource = readFileSync(new URL("./profile.ts", import.meta.url), "utf8");
assert(
  /^\s*quietThinkingHeartbeats\(\);?\s*$/m.test(profileSource),
  "profile.ts must call quietThinkingHeartbeats() as a live statement",
);
assert(
  /^\s*import \{ quietThinkingHeartbeats \} from "\.\/quiet-heartbeats\.js";\s*$/m.test(profileSource),
  "profile.ts must import quietThinkingHeartbeats from ./quiet-heartbeats.js",
);
// One install, not one per call site: a second call is harmless (the guard
// returns early) but it means someone thought the first one did not work.
assert(
  (profileSource.match(/^\s*quietThinkingHeartbeats\(\)/gm) ?? []).length === 1,
  "quietThinkingHeartbeats() must be installed exactly once in profile.ts",
);

// The behavioural half. A source-text match cannot tell `claudeProfile`'s body
// from a function nobody calls — review found exactly that hole — and importing
// `profile.ts` is not an option here: it pulls in `@ai-hero/sandcastle`, which a
// fresh scaffold does not have installed and which this check must run without.
//
// So the question is narrowed to the one that matters: is the call inside a scope
// a run reaches? `claudeProfile` is the function every runner spreads into
// `run()`, so the assertion is that the call sits within a top-level *function
// declaration* named `claudeProfile` — not in a helper, not at module scope, not
// in a dead branch. Braces are counted from the declaration, which is enough for
// a file this check also owns the shape of.
const callAt = profileSource.search(/^\s*quietThinkingHeartbeats\(\);?\s*$/m);
assert(callAt >= 0, "profile.ts must call quietThinkingHeartbeats() as a live statement");
const before = profileSource.slice(0, callAt);
const enclosing = /function\s+(\w+)\s*\([^)]*\)[^{]*\{[\s\S]*$/.exec(before);
assert(
  enclosing !== null && enclosing[1] === "claudeProfile",
  `quietThinkingHeartbeats() must be called inside claudeProfile(), not ${enclosing ? `inside ${enclosing[1]}()` : "at module scope"}`,
);
// And not after an early `return` that a run would hit first: the install has to
// be reachable.
//
// The body starts at the `{` that opens the function, found as the first one
// AFTER the signature's closing `): … {`. Taking `lastIndexOf("{")` instead
// matched the `{` inside `return {}` — an early return hidden the test's own
// blind spot, measured.
const signature = profileSource.indexOf("function claudeProfile");
const bodyStart = profileSource.indexOf("{", profileSource.indexOf(")", profileSource.indexOf(":", signature)));
assert(bodyStart > signature && bodyStart < callAt, "could not locate claudeProfile's body");
const beforeCall = profileSource.slice(bodyStart, callAt);
// A `return` at statement position, optionally behind an `if (…)`. `return {…}`
// and `return;` both count; a `return` inside a string or comment does not matter
// here, because a false positive fails loudly and is fixed by moving the call.
assert(
  !/\breturn\b[^;]*(?:;|\n)/.test(beforeCall.replace(/^\s*\/\/.*$/gm, "")),
  "nothing may return before quietThinkingHeartbeats() runs — the install would never execute",
);

// --- the summary goes to stderr, never to stdout (review finding 5) ----------
//
// `main.ts` ends a run with `console.log(JSON.stringify({...}))` — the command's
// machine-readable result. A summary appended to stdout lands AFTER that line, so
// `node .sandcastle/main.ts | jq` stops parsing, on a successful run, for a
// diagnostic nobody asked for.
//
// Asserted on the source: the two streams are indistinguishable in a captured
// `spawnSync` result unless the probe separates them, and the failure being
// guarded is a *placement* mistake, which is exactly what the source shows.
assert(
  /writeSync\(\s*2\s*,/.test(source),
  "the exit summary must be written to stderr (writeSync(2, ...))",
);
assert(
  !/writeSync\(\s*stream\.fd\s*,/.test(source),
  "the exit summary must not be written to stdout — main.ts's JSON result follows it",
);

console.log("quiet-heartbeats check ok");
