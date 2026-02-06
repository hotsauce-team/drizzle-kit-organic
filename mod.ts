/**
 * @module
 * Patch drizzle-kit for Deno compatibility.
 *
 * @example Run directly
 * ```bash
 * deno run -A jsr:@hotsauce-team/drizzle-kit-deno
 * ```
 *
 * @example Import and use programmatically
 * ```ts
 * import { patchDrizzleKit } from "jsr:@hotsauce-team/drizzle-kit-deno";
 * await patchDrizzleKit();
 * ```
 */

export { patchDrizzleKit, SUPPORTED_VERSIONS } from "./scripts/patch-drizzle-kit.ts";
