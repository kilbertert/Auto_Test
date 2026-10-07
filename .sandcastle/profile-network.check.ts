/**
 * Runnable regression check for profile network selection.
 *
 * Run: `npx tsx .sandcastle/profile-network.check.ts`
 *
 * Asserts the property that decides whether the sandbox is isolated: only the
 * host-loopback profiles get `--network host`; everything else stays on the
 * default bridge. Without this, a typo in the set silently widens the sandbox's
 * reach — or silently breaks the relay profile.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOPBACK_PROFILES, networkFor, sandboxNetworkOptions } from "./profile-network.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`profile-network check failed: ${message}`);
}

// The relay profile reaches host loopback, so it must share the host network.
assert(networkFor("claude-deepseek") === "host", "claude-deepseek must use host networking");

// Profiles that talk to a public HTTPS origin must stay on the default bridge —
// host networking would hand them the host's loopback for no reason. `claude`
// is the only one left: it points at the Anthropic API directly.
assert(networkFor("claude") === undefined, "claude must stay on the default bridge");
assert(networkFor(undefined) === undefined, "no profile means the default bridge");

// The set and the function must agree — a drift here is the whole bug class.
for (const profile of LOOPBACK_PROFILES) {
  assert(networkFor(profile) === "host", `set member ${profile} must map to host networking`);
}
assert(
  [...LOOPBACK_PROFILES].every((p) => p === "claude-deepseek" || p.endsWith("-deepseek")),
  "loopback profiles should be the relay-backed ones",
);

// Assert the **options object** `claudeProfile` splats into `docker()` — this is
// the wiring the helper's return value alone would not cover. A profile that
// should get host networking but receives `{}` compiles, runs, and silently
// cannot reach the relay; only this assertion catches that.
assert(
  JSON.stringify(sandboxNetworkOptions("claude-deepseek")) === JSON.stringify({ network: "host" }),
  "claude-deepseek must produce { network: 'host' } for docker()",
);
assert(
  JSON.stringify(sandboxNetworkOptions(undefined)) === JSON.stringify({}),
  "no profile must produce no docker() network option",
);

// The splatted object must be exactly {} or { network: "host" } — never some
// other network, which would break the relay profile or widen the sandbox.
for (const profile of [...LOOPBACK_PROFILES, "claude", "claude-deepseek", undefined]) {
  const keys = Object.keys(sandboxNetworkOptions(profile));
  assert(
    keys.length === 0 || (keys.length === 1 && keys[0] === "network"),
    `unexpected docker() options for ${String(profile)}: ${keys.join(",")}`,
  );
  const net = sandboxNetworkOptions(profile).network;
  assert(net === undefined || net === "host", `unexpected network for ${String(profile)}: ${String(net)}`);
}

// Finally, assert `profile.ts` **actually consumes** this module. Without this,
// deleting the spread from `claudeProfile` would keep every assertion above
// green while the relay profile silently lost host networking — the wiring gap
// this check exists to close. Read the source rather than importing it, so the
// check stays free of the Sandcastle dependency.
//
// The match is **line-anchored** (`^\s*\.\.\.`) and NOT a bare `includes()`: a
// commented-out `// ...sandboxNetworkOptions(profile),` must not satisfy it, or
// the check would pass for exactly the edit it is meant to catch.
const profileSource = readFileSync(join(import.meta.dirname, "profile.ts"), "utf8");
assert(
  /^\s*\.\.\.sandboxNetworkOptions\(profile\),?\s*$/m.test(profileSource),
  "profile.ts must spread sandboxNetworkOptions(profile) as a live statement in its docker() call",
);
assert(
  !/LOOPBACK_PROFILES/.test(profileSource),
  "profile.ts must not re-implement the loopback set — keep the decision in one module",
);

console.log("profile-network check ok");
