#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Test suite for drizzle-kit patch compatibility across versions.
 *
 * Tests that the patch script successfully patches different versions of drizzle-kit
 * and that the patched binary can execute basic commands.
 *
 * Usage:
 *   deno task test:patch              # Test all supported versions
 *   deno task test:patch 0.30.6       # Test a specific version
 *   deno task test:patch --quick      # Quick test (only checks patch applies)
 */

import { walk } from "@std/fs/walk";
import { parseArgs } from "@std/cli/parse-args";

// Supported versions to test (should match SUPPORTED_VERSIONS in patch-drizzle-kit.ts)
const SUPPORTED_VERSIONS = ["0.30.6", "0.31.8", "0.31.9"];

// Test configuration
const TEST_DIR = ".test-patch";
const TIMEOUT_MS = 120_000; // 2 minutes per version

interface TestResult {
  version: string;
  steps: StepResult[];
  duration: number;
  success: boolean;
}

interface StepResult {
  name: string;
  success: boolean;
  error?: string;
  output?: string;
}

async function runCommand(
  cmd: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  const { cwd = Deno.cwd(), timeout = 60_000 } = options;

  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

  // Set up timeout
  const timeoutId = setTimeout(() => {
    try {
      process.kill("SIGTERM");
    } catch {
      // Process may have already exited
    }
  }, timeout);

  const { success, code, stdout, stderr } = await process.output();

  clearTimeout(timeoutId);

  return {
    success,
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

async function setupTestEnvironment(version: string): Promise<string> {
  const versionDir = `${TEST_DIR}/drizzle-kit-${version}`;

  // Clean up any existing test directory for this version
  try {
    await Deno.remove(versionDir, { recursive: true });
  } catch {
    // Directory may not exist
  }

  await Deno.mkdir(versionDir, { recursive: true });

  // Create minimal deno.jsonc for this test
  const denoConfig = {
    imports: {
      "drizzle-kit": `npm:drizzle-kit@${version}`,
      "drizzle-orm": "npm:drizzle-orm@^0.45.1",
      "@electric-sql/pglite": "npm:@electric-sql/pglite@^0.3.15",
      "@std/fs": "jsr:@std/fs@1",
    },
    nodeModulesDir: "auto",
  };

  await Deno.writeTextFile(
    `${versionDir}/deno.jsonc`,
    JSON.stringify(denoConfig, null, 2),
  );

  // Create a minimal schema for testing
  const schema = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
`;
  await Deno.writeTextFile(`${versionDir}/schema.ts`, schema);

  // Create a minimal drizzle config
  const config = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Use PGlite driver for local dev so tests are self-contained
  ...(Deno.env.get("DATABASE_URL") ? {} : { driver: "pglite" as const }),
  dbCredentials: {
    url: Deno.env.get("DATABASE_URL") || "file:./data",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle.config.ts`, config);

  // Create drizzle output directory
  await Deno.mkdir(`${versionDir}/drizzle`, { recursive: true });

  // Create local DB storage directory for PGlite
  await Deno.mkdir(`${versionDir}/data`, { recursive: true });

  // Copy DB verification script into the test environment
  const verifyDbScript = await Deno.readTextFile("scripts/verify-db.ts");
  await Deno.writeTextFile(`${versionDir}/verify-db.ts`, verifyDbScript);

  return versionDir;
}

async function installDependencies(testDir: string): Promise<StepResult> {
  const result = await runCommand(["deno", "install"], {
    cwd: testDir,
    timeout: TIMEOUT_MS,
  });

  return {
    name: "Install dependencies",
    success: result.success,
    error: result.success ? undefined : result.stderr,
    output: result.stdout,
  };
}

async function copyPatchScript(testDir: string): Promise<StepResult> {
  try {
    // Read the patch script from the main project
    const patchScript = await Deno.readTextFile("scripts/patch-drizzle-kit.ts");

    // Create scripts directory in test environment
    await Deno.mkdir(`${testDir}/scripts`, { recursive: true });

    // Write patch script
    await Deno.writeTextFile(
      `${testDir}/scripts/patch-drizzle-kit.ts`,
      patchScript,
    );

    return {
      name: "Copy patch script",
      success: true,
    };
  } catch (error) {
    return {
      name: "Copy patch script",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runPatchScript(testDir: string): Promise<StepResult> {
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=./node_modules",
      "--allow-write=./node_modules",
      "scripts/patch-drizzle-kit.ts",
    ],
    { cwd: testDir, timeout: TIMEOUT_MS },
  );

  const output = result.stdout + result.stderr;
  const success = result.success && (
    output.includes("Patched drizzle-kit successfully") ||
    output.includes("already patched")
  );

  return {
    name: "Apply patch",
    success,
    error: success
      ? undefined
      : result.stderr || "Patch did not complete successfully",
    output: result.stdout,
  };
}

async function verifyPatchMarker(testDir: string): Promise<StepResult> {
  try {
    // Find the bin.cjs file
    for await (
      const entry of walk(`${testDir}/node_modules`, {
        match: [/drizzle-kit.*\/bin\.cjs$/],
        maxDepth: 6,
      })
    ) {
      if (entry.isFile) {
        const content = await Deno.readTextFile(entry.path);
        const hasMarker = content.includes("DRIZZLE-KIT-DENO-PATCHED-V10");

        return {
          name: "Verify patch marker",
          success: hasMarker,
          error: hasMarker ? undefined : "Patch marker not found in bin.cjs",
        };
      }
    }

    return {
      name: "Verify patch marker",
      success: false,
      error: "Could not find drizzle-kit bin.cjs",
    };
  } catch (error) {
    return {
      name: "Verify patch marker",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Critical patches that MUST be present for drizzle-kit to work
const CRITICAL_PATCH_MARKERS = [
  {
    name: "walkForTsConfig",
    pattern: "return void 0; // PATCHED: disabled for Deno",
  },
  {
    name: "safeRegister",
    pattern:
      "return { unregister: () => {} }; // PATCHED: esbuild disabled for Deno",
  },
  { name: "config loading", pattern: "// PATCHED: import for Deno TS support" },
  {
    name: "CLI exit handler",
    pattern: "setTimeout(() => process.exit(0), 50)",
  },
];

// Non-critical patches (may not be present in all versions)
const OPTIONAL_PATCH_MARKERS = [
  {
    name: "recusivelyResolveSync",
    pattern: "return null; // PATCHED: disabled for Deno",
  },
  {
    name: "_supportsColor stub",
    pattern: "// PATCHED: Return color level 3 (truecolor)",
  },
  {
    name: "supportsColor2 stub",
    pattern:
      "// PATCHED: Return color level 3 (truecolor) without checking env vars for Deno",
  },
  {
    name: "bufferutil skip",
    pattern: "/* PATCHED: skip bufferutil for Deno */",
  },
  {
    name: "dotenv stub",
    pattern: "// PATCHED: Skip DOTENV_CONFIG_* env checks for Deno",
  },
  {
    name: "homedir defer",
    pattern: "// PATCHED: deferred for Deno - will be set on first use",
  },
  { name: "lazy homedir", pattern: "_getHomedir()," },
  { name: "lazy tmpdir", pattern: "_getTmpdir()," },
];

async function verifyAllPatches(testDir: string): Promise<StepResult> {
  try {
    // Find the bin.cjs file
    for await (
      const entry of walk(`${testDir}/node_modules`, {
        match: [/drizzle-kit.*\/bin\.cjs$/],
        maxDepth: 6,
      })
    ) {
      if (entry.isFile) {
        const content = await Deno.readTextFile(entry.path);

        const missingCritical: string[] = [];
        const missingOptional: string[] = [];
        const foundPatches: string[] = [];

        // Check critical patches
        for (const { name, pattern } of CRITICAL_PATCH_MARKERS) {
          if (content.includes(pattern)) {
            foundPatches.push(name);
          } else {
            missingCritical.push(name);
          }
        }

        // Check optional patches
        for (const { name, pattern } of OPTIONAL_PATCH_MARKERS) {
          if (content.includes(pattern)) {
            foundPatches.push(name);
          } else {
            missingOptional.push(name);
          }
        }

        if (missingCritical.length > 0) {
          return {
            name: "Verify all patches applied",
            success: false,
            error: `Missing critical patches: ${missingCritical.join(", ")}`,
            output: `Found: ${foundPatches.join(", ")}\nMissing optional: ${
              missingOptional.join(", ")
            }`,
          };
        }

        return {
          name: "Verify all patches applied",
          success: true,
          output:
            `Critical: ${CRITICAL_PATCH_MARKERS.length}/${CRITICAL_PATCH_MARKERS.length}, Optional: ${
              OPTIONAL_PATCH_MARKERS.length - missingOptional.length
            }/${OPTIONAL_PATCH_MARKERS.length}`,
        };
      }
    }

    return {
      name: "Verify all patches applied",
      success: false,
      error: "Could not find drizzle-kit bin.cjs",
    };
  } catch (error) {
    return {
      name: "Verify all patches applied",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testDrizzleKitHelp(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit --help works (basic smoke test)
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-net",
      "./node_modules/drizzle-kit/bin.cjs",
      "--help",
    ],
    { cwd: testDir, timeout: 30_000 },
  );

  const output = result.stdout + result.stderr;
  const success = output.includes("drizzle-kit") ||
    output.includes("generate") || output.includes("migrate");

  return {
    name: "Test drizzle-kit --help",
    success,
    error: success
      ? undefined
      : result.stderr || "Help command did not produce expected output",
    output: result.stdout.slice(0, 500), // Truncate for readability
  };
}

async function testDrizzleKitGenerate(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit generate works (reads config and schema)
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-net",
      "./node_modules/drizzle-kit/bin.cjs",
      "generate",
    ],
    { cwd: testDir, timeout: 60_000 },
  );

  const output = result.stdout + result.stderr;
  // Success if it generated migrations or said no changes needed
  const success = output.includes("No schema changes") ||
    output.includes("migrations generated") ||
    output.includes("Your schema file") ||
    (result.success && !output.includes("error"));

  return {
    name: "Test drizzle-kit generate",
    success,
    error: success ? undefined : result.stderr || "Generate command failed",
    output: result.stdout.slice(0, 500),
  };
}

async function testDrizzleKitMigrate(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit migrate works (applies migrations to local DB)
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-net",
      "./node_modules/drizzle-kit/bin.cjs",
      "migrate",
    ],
    { cwd: testDir, timeout: 60_000 },
  );

  const output = result.stdout + result.stderr;

  // Be permissive about success wording across versions.
  const success = result.success && !output.toLowerCase().includes("error");

  return {
    name: "Test drizzle-kit migrate",
    success,
    error: success ? undefined : result.stderr || "Migrate command failed",
    output: result.stdout.slice(0, 500),
  };
}

async function verifyDatabaseSchema(testDir: string): Promise<StepResult> {
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      "--allow-net",
      "./verify-db.ts",
    ],
    { cwd: testDir, timeout: 30_000 },
  );

  const output = result.stdout + result.stderr;
  const success = result.success && output.includes("Verified DB schema");

  return {
    name: "Verify migrated DB schema",
    success,
    error: success ? undefined : result.stderr || "DB schema verification failed",
    output: result.stdout.slice(0, 500),
  };
}

async function testVersion(
  version: string,
  options: { quick?: boolean } = {},
): Promise<TestResult> {
  const startTime = Date.now();
  const steps: StepResult[] = [];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Testing drizzle-kit@${version}`);
  console.log(`${"═".repeat(60)}`);

  // Step 1: Setup test environment
  console.log("\n📁 Setting up test environment...");
  const testDir = await setupTestEnvironment(version);
  steps.push({ name: "Setup environment", success: true });

  // Step 2: Install dependencies
  console.log("📦 Installing drizzle-kit...");
  const installResult = await installDependencies(testDir);
  steps.push(installResult);
  if (!installResult.success) {
    console.log(`  ❌ Failed: ${installResult.error}`);
    return { version, steps, duration: Date.now() - startTime, success: false };
  }
  console.log("  ✓ Dependencies installed");

  // Step 3: Copy patch script
  console.log("📋 Copying patch script...");
  const copyResult = await copyPatchScript(testDir);
  steps.push(copyResult);
  if (!copyResult.success) {
    console.log(`  ❌ Failed: ${copyResult.error}`);
    return { version, steps, duration: Date.now() - startTime, success: false };
  }
  console.log("  ✓ Patch script copied");

  // Step 4: Run patch script
  console.log("🔧 Applying patch...");
  const patchResult = await runPatchScript(testDir);
  steps.push(patchResult);
  if (!patchResult.success) {
    console.log(`  ❌ Failed: ${patchResult.error}`);
    if (patchResult.output) {
      console.log(`  Output: ${patchResult.output}`);
    }
    return { version, steps, duration: Date.now() - startTime, success: false };
  }
  console.log("  ✓ Patch applied");

  // Step 5: Verify patch marker
  console.log("🔍 Verifying patch marker...");
  const markerResult = await verifyPatchMarker(testDir);
  steps.push(markerResult);
  if (!markerResult.success) {
    console.log(`  ❌ Failed: ${markerResult.error}`);
    return { version, steps, duration: Date.now() - startTime, success: false };
  }
  console.log("  ✓ Patch marker verified");

  // Step 6: Verify all individual patches were applied
  console.log("🔬 Verifying all patches applied...");
  const allPatchesResult = await verifyAllPatches(testDir);
  steps.push(allPatchesResult);
  if (!allPatchesResult.success) {
    console.log(`  ❌ Failed: ${allPatchesResult.error}`);
    if (allPatchesResult.output) {
      console.log(`  ${allPatchesResult.output}`);
    }
    return { version, steps, duration: Date.now() - startTime, success: false };
  }
  console.log(`  ✓ All patches verified (${allPatchesResult.output})`);

  if (!options.quick) {
    // Step 7: Test drizzle-kit --help
    console.log("🧪 Testing drizzle-kit --help...");
    const helpResult = await testDrizzleKitHelp(testDir);
    steps.push(helpResult);
    if (!helpResult.success) {
      console.log(`  ❌ Failed: ${helpResult.error}`);
      return {
        version,
        steps,
        duration: Date.now() - startTime,
        success: false,
      };
    }
    console.log("  ✓ Help command works");

    // Step 8: Test drizzle-kit generate
    console.log("🧪 Testing drizzle-kit generate...");
    const generateResult = await testDrizzleKitGenerate(testDir);
    steps.push(generateResult);
    if (!generateResult.success) {
      console.log(`  ❌ Failed: ${generateResult.error}`);
      return {
        version,
        steps,
        duration: Date.now() - startTime,
        success: false,
      };
    }
    console.log("  ✓ Generate command works");

    // Step 9: Test drizzle-kit migrate
    console.log("🧪 Testing drizzle-kit migrate...");
    const migrateResult = await testDrizzleKitMigrate(testDir);
    steps.push(migrateResult);
    if (!migrateResult.success) {
      console.log(`  ❌ Failed: ${migrateResult.error}`);
      return {
        version,
        steps,
        duration: Date.now() - startTime,
        success: false,
      };
    }
    console.log("  ✓ Migrate command works");

    // Step 10: Verify DB schema reflects applied migrations
    console.log("🔎 Verifying migrated DB schema...");
    const verifyDbResult = await verifyDatabaseSchema(testDir);
    steps.push(verifyDbResult);
    if (!verifyDbResult.success) {
      console.log(`  ❌ Failed: ${verifyDbResult.error}`);
      if (verifyDbResult.output) {
        console.log(`  Output: ${verifyDbResult.output}`);
      }
      return {
        version,
        steps,
        duration: Date.now() - startTime,
        success: false,
      };
    }
    console.log("  ✓ DB schema verified");
  }

  const duration = Date.now() - startTime;
  console.log(
    `\n✅ drizzle-kit@${version} passed all tests (${
      (duration / 1000).toFixed(1)
    }s)`,
  );

  return { version, steps, duration, success: true };
}

async function cleanup() {
  console.log("\n🧹 Cleaning up test directory...");
  try {
    await Deno.remove(TEST_DIR, { recursive: true });
    console.log("  ✓ Cleanup complete");
  } catch {
    console.log("  ⚠ No cleanup needed");
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["quick", "keep", "help"],
    alias: { q: "quick", k: "keep", h: "help" },
  });

  if (args.help) {
    console.log(`
drizzle-kit Patch Test Suite

Usage:
  deno task test:patch [options] [versions...]

Options:
  --quick, -q    Quick test (only verify patch applies, skip runtime tests)
  --keep, -k     Keep test directories after completion
  --help, -h     Show this help message

Examples:
  deno task test:patch              # Test all supported versions
  deno task test:patch 0.30.6       # Test a specific version
  deno task test:patch --quick      # Quick test all versions
  deno task test:patch -q 0.30.4    # Quick test specific version
`);
    Deno.exit(0);
  }

  // Determine which versions to test
  const versionsToTest = args._.length > 0
    ? args._.map(String)
    : SUPPORTED_VERSIONS;

  // Validate versions
  for (const version of versionsToTest) {
    if (!SUPPORTED_VERSIONS.includes(version)) {
      console.warn(`⚠️  Version ${version} is not in SUPPORTED_VERSIONS list`);
      console.warn(`   Supported: ${SUPPORTED_VERSIONS.join(", ")}`);
      console.warn("   Testing anyway...\n");
    }
  }

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║        drizzle-kit Patch Compatibility Test Suite          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nVersions to test: ${versionsToTest.join(", ")}`);
  console.log(
    `Mode: ${args.quick ? "Quick (patch only)" : "Full (patch + runtime)"}`,
  );

  const results: TestResult[] = [];

  for (const version of versionsToTest) {
    const result = await testVersion(version, { quick: args.quick });
    results.push(result);
  }

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log("TEST SUMMARY");
  console.log("═".repeat(60));

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  for (const result of results) {
    const status = result.success ? "✅ PASS" : "❌ FAIL";
    const duration = (result.duration / 1000).toFixed(1);
    console.log(`  ${status}  drizzle-kit@${result.version} (${duration}s)`);

    if (!result.success) {
      const failedStep = result.steps.find((s) => !s.success);
      if (failedStep) {
        console.log(`         └─ Failed at: ${failedStep.name}`);
        if (failedStep.error) {
          console.log(`            Error: ${failedStep.error}`);
        }
        if (failedStep.output) {
          console.log(`            Output: ${failedStep.output}`);
        }
      }
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log(
    `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`,
  );

  // Cleanup unless --keep flag
  if (!args.keep) {
    await cleanup();
  } else {
    console.log(`\n📁 Test directories kept at: ${TEST_DIR}/`);
  }

  // Exit with appropriate code for CI
  if (failed.length > 0) {
    console.log("\n❌ Some tests failed");
    Deno.exit(1);
  }

  console.log("\n✅ All tests passed!");
  Deno.exit(0);
}

await main();
