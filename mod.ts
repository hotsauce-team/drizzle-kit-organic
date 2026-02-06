/**
 * @module
 * Patch drizzle-kit for Deno compatibility.
 *
 * @example Run directly
 * ```bash
 * deno run -A jsr:@hotsauce-team/drizzle-kit-deno-patch
 * ```
 *
 * @example Import and use programmatically
 * ```ts
 * import { patchDrizzleKit } from "jsr:@hotsauce-team/drizzle-kit-deno-patch";
 * await patchDrizzleKit();
 * ```
 */

export { patchDrizzleKit, SUPPORTED_VERSIONS } from "./scripts/patch-drizzle-kit.ts";
