/**
 * Which profiles need a host-network sandbox.
 *
 * Kept in its own module — with **no import of the Sandcastle package** — so the
 * branching decision is runnable under plain `tsx`/`node` without the heavy
 * provider dependency. `profile.ts` consumes it; `profile-network.check.ts`
 * asserts it.
 *
 * Why any profile needs host networking: a relay bound to the host's **loopback**
 * cannot be reached from a default-bridge container (measured). Sharing the host
 * network namespace is the only way in — and it is a real cost: the sandbox loses
 * Docker's bridge isolation and can reach other host-loopback services. So only
 * the profiles whose endpoint is host-loopback belong in this set; anything
 * talking to a public HTTPS origin stays on the default bridge.
 */

//: Profiles whose endpoint is the host-loopback relay (`cli-proxy-api`).
export const LOOPBACK_PROFILES: ReadonlySet<string> = new Set<string>(["claude-deepseek"]);

/** The `docker()` network for a profile: `"host"` only for loopback profiles. */
export function networkFor(profile: string | undefined): "host" | undefined {
  return profile && LOOPBACK_PROFILES.has(profile) ? "host" : undefined;
}

/**
 * The network-related slice of `docker()` options for a profile.
 *
 * `claudeProfile` spreads exactly this into its `docker({...})` call, so the
 * check can assert the **options the provider actually receives** — not just the
 * helper's return value. This is the seam Devin Review flagged: testing
 * `networkFor` alone would stay green even if `claudeProfile` stopped using it.
 */
export function sandboxNetworkOptions(profile: string | undefined): { network?: "host" } {
  const network = networkFor(profile);
  return network ? { network } : {};
}
