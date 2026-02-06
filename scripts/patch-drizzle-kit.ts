/**
 * Post-install script to patch drizzle-kit for Deno compatibility.
 *
 * Patches:
 * 1. Disables walkForTsConfig - prevents directory traversal permission issues
 * 2. Disables recursivelyResolveSync - prevents parent directory traversal
 * 3. Disables safeRegister - removes esbuild dependency (Deno has native TS)
 * 4. Replaces require() with import() - Deno supports TS via import(), not require()
 * 5. Adds process.exit(0) after commands - prevents hanging event loop
 * 6. Stubs color support functions - avoids env var checks at load time
 * 7. Defers homedir/tmpdir calls - avoids permission prompts at load time
 */

import { walk } from "@std/fs/walk";

const NODE_MODULES = "./node_modules";
const PATCH_MARKER = "// DRIZZLE-KIT-DENO-PATCHED-V10";

/** Drizzle-kit versions that have been tested with this patch */
export const SUPPORTED_VERSIONS = ["0.30.6", "0.31.8"];

interface PatchResult {
  name: string;
  success: boolean;
  error?: string;
}

async function findDrizzleKitBin(): Promise<
  { path: string; version: string } | null
> {
  for await (
    const entry of walk(NODE_MODULES, {
      match: [/drizzle-kit.*\/bin\.cjs$/],
      maxDepth: 6,
    })
  ) {
    if (entry.isFile) {
      // Extract version from path like node_modules/.deno/drizzle-kit@0.30.6/...
      const versionMatch = entry.path.match(/drizzle-kit@(\d+\.\d+\.\d+)/);
      const version = versionMatch?.[1] ?? "unknown";
      return { path: entry.path, version };
    }
  }
  return null;
}

function applyPatch(
  content: string,
  name: string,
  searchPattern: RegExp | string,
  replacement: string | ((match: string, ...args: string[]) => string),
): { content: string; result: PatchResult } {
  const pattern = typeof searchPattern === "string"
    ? new RegExp(escapeRegex(searchPattern), "g")
    : searchPattern;

  // Reset lastIndex for global regexes
  pattern.lastIndex = 0;

  if (!pattern.test(content)) {
    return {
      content,
      result: { name, success: false, error: "Pattern not found" },
    };
  }

  pattern.lastIndex = 0;
  const newContent = content.replace(pattern, replacement as string);

  if (newContent === content) {
    return {
      content,
      result: { name, success: false, error: "Replacement had no effect" },
    };
  }

  return {
    content: newContent,
    result: { name, success: true },
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function patchDrizzleKit() {
  const result = await findDrizzleKitBin();

  if (!result) {
    console.error("❌ Could not find drizzle-kit bin.cjs");
    console.error("   Make sure you've run `deno install` first");
    Deno.exit(1);
  }

  const { path: binPath, version } = result;
  console.log(`📦 Found drizzle-kit@${version} at: ${binPath}`);

  // Version check
  if (!SUPPORTED_VERSIONS.includes(version) && version !== "unknown") {
    console.warn(
      `⚠️  drizzle-kit@${version} may not be compatible (tested: ${
        SUPPORTED_VERSIONS.join(", ")
      })`,
    );
    console.warn("   Attempting to patch anyway...\n");
  }

  let content = await Deno.readTextFile(binPath);
  const results: PatchResult[] = [];

  // Check if already patched with current version
  if (content.includes(PATCH_MARKER)) {
    console.log("✅ drizzle-kit already patched (v10)");
    return;
  }

  // Check for older patch versions - re-patch if found
  const oldPatchMatch = content.match(/\/\/ DRIZZLE-KIT-DENO-PATCHED-V(\d+)/);
  if (oldPatchMatch) {
    console.log(
      `♻️  Found older patch (v${oldPatchMatch[1]}), will re-patch to v10`,
    );
    // Note: We proceed to patch over the old version
  }

  // Insert patch marker after shebang (if present) to avoid syntax errors
  if (content.startsWith("#!")) {
    const firstNewline = content.indexOf("\n");
    content = content.slice(0, firstNewline + 1) + PATCH_MARKER + "\n" +
      content.slice(firstNewline + 1);
  } else {
    content = `${PATCH_MARKER}\n${content}`;
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 1: walkForTsConfig - disable directory traversal
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "walkForTsConfig",
      /function walkForTsConfig\(directory[^)]*\)\s*\{/g,
      `function walkForTsConfig(directory, readdirSync) {
  return void 0; // PATCHED: disabled for Deno`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 2: recusivelyResolveSync - disable parent traversal
  // (Note: typo "recusively" is in original drizzle-kit code)
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "recusivelyResolveSync",
      /recusivelyResolveSync\(options\)\s*\{/g,
      `recusivelyResolveSync(options) {
    return null; // PATCHED: disabled for Deno`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 3: Stub _supportsColor (chalk library)
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "stub _supportsColor (chalk)",
      /function _supportsColor\(haveStream,\s*\{[^}]*\}\s*=\s*\{\}\)\s*\{/g,
      `function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
  // PATCHED: Return color level 3 (truecolor) without checking env vars for Deno
  return 3;
  // Original code below (unreachable):`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 3b: Stub supportsColor2 (colors@1.4.0)
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "stub supportsColor2 (colors)",
      /function supportsColor2\(stream\)\s*\{/g,
      `function supportsColor2(stream) {
      // PATCHED: Return color level 3 (truecolor) without checking env vars for Deno
      return 3;
      // Original code below (unreachable):`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 3c: Skip bufferutil loading (ws library)
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "skip bufferutil (ws)",
      /if \(!process\.env\.WS_NO_BUFFER_UTIL\) \{/g,
      `if (false /* PATCHED: skip bufferutil for Deno */ && !process.env.WS_NO_BUFFER_UTIL) {`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 4: Stub dotenv env-options
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "stub dotenv env-options",
      /"\.\.\/node_modules\/\.pnpm\/dotenv@[^"]+\/node_modules\/dotenv\/lib\/env-options\.js"\(exports2, module2\) \{\s*var options = \{\};/g,
      `"../node_modules/.pnpm/dotenv@16.4.5/node_modules/dotenv/lib/env-options.js"(exports2, module2) {
    // PATCHED: Skip DOTENV_CONFIG_* env checks for Deno
    module2.exports = {};
    return;
    var options = {};`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 4b: Stub dotenv config auto-call
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "stub dotenv config auto-call",
      /\/\/ \.\.\/node_modules\/\.pnpm\/dotenv@[^/]+\/node_modules\/dotenv\/config\.js\s*\(function\(\) \{\s*require_main\(\)\.config\(/g,
      `// ../node_modules/.pnpm/dotenv@16.4.5/node_modules/dotenv/config.js
// PATCHED: Skip dotenv auto-config for Deno
(function() { return; require_main().config(`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 5: Defer os.homedir() call
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "defer homedir (env-paths)",
      /var homedir = import_node_os2\.default\.homedir\(\);/g,
      `var homedir = ""; // PATCHED: deferred for Deno - will be set on first use
var _getHomedir = () => { if (!homedir) homedir = import_node_os2.default.homedir(); return homedir; };`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 5b: Defer os.tmpdir() call
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "defer tmpdir (env-paths)",
      /var tmpdir = import_node_os2\.default\.tmpdir\(\);/g,
      `var tmpdir = ""; // PATCHED: deferred for Deno - will be set on first use
var _getTmpdir = () => { if (!tmpdir) tmpdir = import_node_os2.default.tmpdir(); return tmpdir; };`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 5c: Update homedir usages to use lazy getter
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "lazy homedir usage",
      /import_node_path\.default\.join\(homedir,/g,
      `import_node_path.default.join(_getHomedir(),`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 5d: Update tmpdir usages to use lazy getter
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "lazy tmpdir usage",
      /import_node_path\.default\.join\(tmpdir,/g,
      `import_node_path.default.join(_getTmpdir(),`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 6: safeRegister - disable esbuild
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "safeRegister (disable esbuild)",
      /safeRegister\s*=\s*async\s*\(\)\s*=>\s*\{/g,
      `safeRegister = async () => {
    return { unregister: () => {} }; // PATCHED: esbuild disabled for Deno`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 7: require() → import() for config loading
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "config loading (require → import)",
      /const required = require\(`\$\{(\w+)\}`\);/g,
      `const required = await import($1); // PATCHED: import for Deno TS support`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 8: require() → import() for schema file loading
  // ─────────────────────────────────────────────────────────────
  {
    const { content: newContent, result } = applyPatch(
      content,
      "schema loading (require → import)",
      /const i0 = require\(`\$\{(\w+)\}`\);/g,
      `const i0 = await import($1); // PATCHED: import for Deno TS support`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Patch 9: Add process.exit(0) after CLI runs
  // ─────────────────────────────────────────────────────────────
  {
    const runPattern =
      /^(run\(\[generate, migrate, pull, push, studio.*\], \{[\s\S]*?\}\));?\s*$/m;
    const { content: newContent, result } = applyPatch(
      content,
      "CLI exit handler",
      runPattern,
      `$1.then(() => { setTimeout(() => process.exit(0), 50); }); // PATCHED: force exit for Deno`,
    );
    content = newContent;
    results.push(result);
  }

  // ─────────────────────────────────────────────────────────────
  // Print results
  // ─────────────────────────────────────────────────────────────
  console.log("\nPatch results:");
  let hasFailure = false;
  for (const result of results) {
    if (result.success) {
      console.log(`  ✓ ${result.name}`);
    } else {
      console.log(`  ✗ ${result.name}: ${result.error}`);
      hasFailure = true;
    }
  }

  // Require at least the critical patches
  const criticalPatches = [
    "safeRegister (disable esbuild)",
    "config loading (require → import)",
    "schema loading (require → import)",
  ];
  const criticalFailures = results.filter(
    (r) => !r.success && criticalPatches.includes(r.name),
  );

  if (criticalFailures.length > 0) {
    console.error(
      "\n❌ Critical patches failed - drizzle-kit may not work correctly",
    );
    Deno.exit(1);
  }

  await Deno.writeTextFile(binPath, content);

  if (hasFailure) {
    console.log(
      "\n⚠️  Some non-critical patches failed, but drizzle-kit should work",
    );
  } else {
    console.log("\n✅ Patched drizzle-kit successfully");
  }
}

export { patchDrizzleKit };

// Run when executed directly
if (import.meta.main) {
  await patchDrizzleKit();
}
