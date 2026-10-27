/**
 * Drop Claude Code's `thinking_tokens` frames from an agent run's console output.
 *
 * What the noise is. `claude --print --verbose --output-format stream-json` emits
 * one JSON line per event. While the model is thinking, the CLI streams a frame
 * per estimated-token step:
 *
 *   {"type":"system","subtype":"thinking_tokens","estimated_tokens":42,
 *    "estimated_tokens_delta":4,"session_id":"…","uuid":"…"}
 *
 * Measured 2026-10-27 against Claude Code 2.1.311 on one real prompt: 227–342 of
 * these frames in a single run, **58% of all output bytes**, against a handful of
 * `assistant` / `tool_use` / `result` lines. In a GitHub Actions log that is the
 * whole visible run: the reader scrolls hundreds of heartbeat lines to find the
 * one tool call that matters.
 *
 * Why the filter is here and not at the CLI. There is no flag or environment
 * variable that turns the frames off: `CLAUDE_CODE_DISABLE_THINKING=1` and
 * `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0` were both measured and both still
 * emitted them (232 and 342 frames respectively). The frame is part of the
 * stream-json contract — an interactive client renders it as a spinner, so the
 * CLI has no reason to omit it.
 *
 * Why not simply drop `verbose`. `verbose` is what appends the raw lines at all,
 * and it is the only way this host sees tool calls outside sandcastle's four-entry
 * table (Bash, WebSearch, WebFetch, Agent) — see the 1.6.5 upgrade step. Removing
 * it to silence the heartbeats would restore the blindness it was added to fix.
 *
 * So: keep every raw line, drop exactly the heartbeat frames. The match is a
 * parsed `type`/`subtype` pair rather than a substring, because an agent that
 * prints this JSON in its own answer must still have its answer shown, and
 * because the field order of a provider's serialisation is not ours to rely on.
 */

import { writeSync } from "node:fs";

/** How the stream names the frame this module drops. */
const HEARTBEAT_TYPE = "system";
const HEARTBEAT_SUBTYPE = "thinking_tokens";
let suppressed = 0;
let installed = false;

/** True for one `thinking_tokens` frame, and for nothing else. */
export function isThinkingHeartbeat(line: string): boolean {
  // Cheap gate before parsing: every frame of interest is a one-line JSON object
  // whose first field is `type`. Anything else (plain agent text, tool output,
  // the CLI's own warnings) is left alone without a parse.
  if (!line.startsWith("{") || !line.includes(HEARTBEAT_SUBTYPE)) return false;
  try {
    const frame = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    return frame.type === HEARTBEAT_TYPE && frame.subtype === HEARTBEAT_SUBTYPE;
  } catch {
    return false;
  }
}

/**
 * Install the filter on `process.stdout`, and report the count at the end.
 *
 * Patching `stdout` rather than passing a sink is deliberate: sandcastle's verbose
 * sink is `process.stdout.write(line + "\n")` with no hook around it, and every
 * runner in this scaffold reaches it through `claudeProfile()`. One wrapper here
 * covers all seven, and a future runner inherits it by construction. Not patching
 * a stream passed in as an argument is the same point the other way: a second
 * writer would be a second place to forget.
 *
 * The count is printed because the frame name belongs to another product: if a
 * Claude Code release renames `thinking_tokens`, the filter goes quietly inert and
 * the flood returns with nothing failing. A run that ends with "dropped 0" is the
 * signal that the match needs revisiting.
 *
 * TWO details of the writable-stream contract this has to respect, both of which
 * a naive drop gets wrong (both found in review of the first version):
 *
 *   1. `write(chunk[, encoding][, callback])` calls the callback even when the
 *      write completes synchronously. A suppressed write that returns `true`
 *      without invoking it leaves a caller awaiting that callback pending
 *      forever — and stdout is process-wide, so that is every writer in the
 *      runner, not just the verbose sink.
 *   2. A write queued from the `exit` event is not guaranteed to reach a piped
 *      destination: `exit` cannot wait for asynchronous writes to flush, and
 *      Actions captures stdout through a pipe. The count is the one signal this
 *      module exists to leave behind, so it is written synchronously instead.
 */
export function quietThinkingHeartbeats(): void {
  if (installed) return;
  installed = true;
  const stream = process.stdout;
  const write = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      // Sandcastle writes one raw line per call, terminator included. Requiring
      // the terminator keeps a partial write from being judged on half a line.
      if (chunk.endsWith("\n") && isThinkingHeartbeat(chunk.slice(0, -1))) {
        suppressed += 1;
        // Honour the callback the caller passed. It is the last argument when it
        // is a function: `write(chunk)`, `write(chunk, cb)`,
        // `write(chunk, encoding, cb)`. Called on the next tick rather than
        // inline, which is how a real write delivers it.
        const callback = rest[rest.length - 1];
        if (typeof callback === "function") {
          process.nextTick(callback as () => void);
        }
        return true;
      }
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write;

  process.on("exit", () => {
    // Synchronous on purpose — see (2) above. `fs.writeSync` on the same fd keeps
    // the bytes in order behind whatever `stream.write` has already handed to the
    // kernel, and it cannot be discarded by process termination.
    //
    // But a synchronous write to a PIPE is not infallible: Node's stdout on a pipe
    // is non-blocking, so if the reader has not drained it the write can fail with
    // EAGAIN. That case is exactly a failing run — the one whose diagnostic
    // matters most — so a swallowed error must not be the end of it. Fall back to
    // stderr, which is a separate fd with its own buffer.
    const summary = `[afk] dropped ${suppressed} thinking-token frame(s) from the console stream\n`;
    try {
      writeSync(stream.fd, summary);
    } catch {
      try {
        writeSync(2, summary);
      } catch {
        // Both descriptors unusable: a closed pipe is not worth failing a
        // completed run over. Nothing else is left to report through.
      }
    }
  });
}

/** Frames dropped so far. Exported for the runnable check. */
export function thinkingHeartbeatsSuppressed(): number {
  return suppressed;
}
