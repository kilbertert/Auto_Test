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

console.log("quiet-heartbeats check ok");
