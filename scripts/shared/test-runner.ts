/**
 * Generic test runner for drizzle-kit patch tests.
 * 
 * This module provides a dialect-agnostic test runner that executes
 * the same test flow for any database dialect (PostgreSQL, SQLite/LibSQL, etc).
 */

import { walk } from "@std/fs/walk";
import { parseArgs } from "@std/cli/parse-args";
import type {
  DialectConfig,
  StepResult,
  TestResult,
  TestContext,
  IndependentTestResult,
  TestName,
} from "./types.ts";
import { AVAILABLE_TESTS, SUPPORTED_VERSIONS } from "./types.ts";

const TIMEOUT_MS = 120_000; // 2 minutes per version

// =============================================================================
// Utility Functions
// =============================================================================

export async function runCommand(
  cmd: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}
): Promise<{ success: boolean; stdout: string; stderr: string; code: number }> {
  const { cwd = Deno.cwd(), timeout = 60_000, env } = options;

  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: env ? { ...Deno.env.toObject(), ...env } : undefined,
  });

  const process = command.spawn();

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

function createTestContext(): TestContext {
  return {
    generatedMigrations: false,
    migratedDb: false,
    pushedDb: false,
  };
}

// =============================================================================
// Setup Functions
// =============================================================================

async function setupTestEnvironment(
  config: DialectConfig,
  version: string
): Promise<string> {
  const versionDir = `${config.testDir}/drizzle-kit-${version}`;

  // Clean up any existing test directory
  try {
    await Deno.remove(versionDir, { recursive: true });
  } catch {
    // Directory may not exist
  }

  await Deno.mkdir(versionDir, { recursive: true });

  // Create deno.jsonc with dialect-specific dependencies
  const denoConfig = {
    imports: {
      "drizzle-kit": `npm:drizzle-kit@${version}`,
      "drizzle-orm": "npm:drizzle-orm@^0.45.1",
      "@std/fs": "jsr:@std/fs@1",
      ...config.dependencies,
    },
    nodeModulesDir: "auto",
  };

  await Deno.writeTextFile(
    `${versionDir}/deno.jsonc`,
    JSON.stringify(denoConfig, null, 2)
  );

  // Create schema, config files
  await Deno.writeTextFile(`${versionDir}/schema.ts`, config.schemaTs);
  await Deno.writeTextFile(`${versionDir}/drizzle.config.ts`, config.configTs);
  await Deno.writeTextFile(`${versionDir}/drizzle-push.config.ts`, config.pushConfigTs);
  await Deno.writeTextFile(`${versionDir}/drizzle-pull.config.ts`, config.pullConfigTs);

  // Create required directories
  for (const dir of config.dirs) {
    await Deno.mkdir(`${versionDir}/${dir}`, { recursive: true });
  }

  // Copy verification script
  const verifyDbContent = await Deno.readTextFile(config.verifyDbPath);
  await Deno.writeTextFile(`${versionDir}/verify-db.ts`, verifyDbContent);

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
    const patchScript = await Deno.readTextFile("scripts/patch-drizzle-kit.ts");
    await Deno.mkdir(`${testDir}/scripts`, { recursive: true });
    await Deno.writeTextFile(`${testDir}/scripts/patch-drizzle-kit.ts`, patchScript);
    return { name: "Copy patch script", success: true };
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
      "--allow-read=.",
      "--allow-write=./node_modules",
      "./scripts/patch-drizzle-kit.ts",
    ],
    { cwd: testDir, timeout: 30_000 }
  );

  const output = result.stdout + result.stderr;
  const success =
    result.success &&
    (output.includes("Patched drizzle-kit successfully") ||
      output.includes("already patched"));

  return {
    name: "Apply patch",
    success,
    error: success ? undefined : result.stderr || "Patch did not complete successfully",
    output: result.stdout,
  };
}

// =============================================================================
// Patch Verification (optional, used by pgsql)
// =============================================================================

async function verifyPatchMarker(
  testDir: string,
  marker: string
): Promise<StepResult> {
  try {
    for await (const entry of walk(`${testDir}/node_modules`, {
      match: [/drizzle-kit.*\/bin\.cjs$/],
      maxDepth: 6,
    })) {
      if (entry.isFile) {
        const content = await Deno.readTextFile(entry.path);
        const hasMarker = content.includes(marker);
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

async function verifyAllPatches(
  testDir: string,
  criticalPatches: Array<{ name: string; pattern: string }>,
  optionalPatches: Array<{ name: string; pattern: string }>
): Promise<StepResult> {
  try {
    for await (const entry of walk(`${testDir}/node_modules`, {
      match: [/drizzle-kit.*\/bin\.cjs$/],
      maxDepth: 6,
    })) {
      if (entry.isFile) {
        const content = await Deno.readTextFile(entry.path);

        const missingCritical: string[] = [];
        const missingOptional: string[] = [];
        const foundPatches: string[] = [];

        for (const { name, pattern } of criticalPatches) {
          if (content.includes(pattern)) {
            foundPatches.push(name);
          } else {
            missingCritical.push(name);
          }
        }

        for (const { name, pattern } of optionalPatches) {
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
            output: `Found: ${foundPatches.join(", ")}\nMissing optional: ${missingOptional.join(", ")}`,
          };
        }

        return {
          name: "Verify all patches applied",
          success: true,
          output: `Critical: ${criticalPatches.length}/${criticalPatches.length}, Optional: ${optionalPatches.length - missingOptional.length}/${optionalPatches.length}`,
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

// =============================================================================
// Test Functions
// =============================================================================

async function testDrizzleKitHelp(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const result = await runCommand(
    ["deno", "run", ...config.permissions.help, "./node_modules/drizzle-kit/bin.cjs", "--help"],
    { cwd: testDir, timeout: 30_000 }
  );

  const output = result.stdout + result.stderr;
  const hasHelpOutput =
    output.includes("drizzle-kit") &&
    (output.includes("generate") || output.includes("push") || output.includes("pull"));

  return {
    name: "Test drizzle-kit --help",
    success: result.success && hasHelpOutput,
    error: result.success && hasHelpOutput ? undefined : result.stderr || "Help output not as expected",
    output: output.slice(0, 500),
  };
}

async function testDrizzleKitGenerate(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const result = await runCommand(
    ["deno", "run", ...config.permissions.generate, "./node_modules/drizzle-kit/bin.cjs", "generate"],
    { cwd: testDir, timeout: 60_000, env: config.env }
  );

  const output = result.stdout + result.stderr;
  const success =
    output.includes("No schema changes") ||
    output.includes("migrations generated") ||
    output.includes("Your schema file") ||
    (result.success && !output.includes("error"));

  return {
    name: "Test drizzle-kit generate",
    success,
    error: success ? undefined : result.stderr || "Generate command failed",
    output: output.slice(0, 500),
  };
}

async function testDrizzleKitMigrate(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const result = await runCommand(
    ["deno", "run", ...config.permissions.migrate, "./node_modules/drizzle-kit/bin.cjs", "migrate"],
    { cwd: testDir, timeout: 60_000, env: config.env }
  );

  const output = result.stdout + result.stderr;
  const success = result.success && !output.toLowerCase().includes("error");

  return {
    name: "Test drizzle-kit migrate",
    success,
    error: success ? undefined : result.stderr || "Migrate command failed",
    output: output.slice(0, 500),
  };
}

async function verifyDatabaseSchema(
  testDir: string,
  config: DialectConfig,
  args: string[]
): Promise<StepResult> {
  const result = await runCommand(
    ["deno", "run", ...config.permissions.verifyMigrate, "./verify-db.ts", ...args],
    { cwd: testDir, timeout: 30_000, env: config.env }
  );

  const output = result.stdout + result.stderr;
  const success = result.success && output.includes("Verified DB schema");

  return {
    name: "Verify migrated DB schema",
    success,
    error: success ? undefined : result.stderr || "DB schema verification failed",
    output: output.slice(0, 500),
  };
}

async function testDrizzleKitPush(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const result = await runCommand(
    [
      "deno",
      "run",
      ...config.permissions.push,
      "./node_modules/drizzle-kit/bin.cjs",
      "push",
      "--config=drizzle-push.config.ts",
      "--force",
    ],
    { cwd: testDir, timeout: 60_000, env: config.env }
  );

  return {
    name: "Test drizzle-kit push",
    success: result.success,
    error: result.success ? undefined : result.stderr || "Push command failed",
    output: (result.stdout + result.stderr).slice(0, 500),
  };
}

async function verifyPushDatabaseSchema(
  testDir: string,
  config: DialectConfig,
  args: string[]
): Promise<StepResult> {
  const result = await runCommand(
    ["deno", "run", ...config.permissions.verifyPush, "./verify-db.ts", ...args],
    { cwd: testDir, timeout: 30_000, env: config.env }
  );

  const output = result.stdout + result.stderr;
  const success = result.success && output.includes("Verified DB schema");

  return {
    name: "Verify push DB schema",
    success,
    error: success ? undefined : result.stderr || "Push DB schema verification failed",
    output: output.slice(0, 500),
  };
}

async function testDrizzleKitPull(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const result = await runCommand(
    [
      "deno",
      "run",
      ...config.permissions.pull,
      "./node_modules/drizzle-kit/bin.cjs",
      "pull",
      "--config=drizzle-pull.config.ts",
    ],
    { cwd: testDir, timeout: 60_000, env: config.env }
  );

  return {
    name: "Test drizzle-kit pull",
    success: result.success,
    error: result.success ? undefined : result.stderr || "Pull command failed",
    output: (result.stdout + result.stderr).slice(0, 500),
  };
}

async function verifyPullSchema(
  testDir: string,
  config: DialectConfig
): Promise<StepResult> {
  const pullDir = `${testDir}/drizzle-pull`;

  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(pullDir)) {
      entries.push(entry.name);
    }

    const schemaFile = entries.find((e) => e.endsWith(".ts") && e.includes("schema"));
    if (!schemaFile) {
      return {
        name: "Verify pull schema",
        success: false,
        error: `Expected schema file in drizzle-pull/, found: ${entries.join(", ") || "<empty>"}`,
      };
    }

    const content = await Deno.readTextFile(`${pullDir}/${schemaFile}`);
    const result = config.verifyPullSchema(content);

    return {
      name: "Verify pull schema",
      success: result.success,
      error: result.error,
      output: result.success ? `Found ${entries.length} file(s): ${entries.join(", ")}` : content.slice(0, 500),
    };
  } catch (e) {
    return {
      name: "Verify pull schema",
      success: false,
      error: `Failed to read drizzle-pull/: ${e}`,
    };
  }
}

// =============================================================================
// Independent Test Runners
// =============================================================================

async function runHelpTest(
  testDir: string,
  config: DialectConfig,
  _ctx: TestContext
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];

  console.log("🧪 Testing drizzle-kit --help...");
  const helpResult = await testDrizzleKitHelp(testDir, config);
  steps.push(helpResult);

  if (!helpResult.success) {
    console.log(`  ❌ Failed: ${helpResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Help command works");

  return { steps, success: true };
}

async function runGenerateTest(
  testDir: string,
  config: DialectConfig,
  ctx: TestContext
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];

  console.log("🧪 Testing drizzle-kit generate...");
  const generateResult = await testDrizzleKitGenerate(testDir, config);
  steps.push(generateResult);

  if (!generateResult.success) {
    console.log(`  ❌ Failed: ${generateResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Generate command works");
  ctx.generatedMigrations = true;

  return { steps, success: true };
}

async function runMigrateTest(
  testDir: string,
  config: DialectConfig,
  ctx: TestContext
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];

  // Prerequisite: generate migrations first
  if (!ctx.generatedMigrations) {
    console.log("📋 Running prerequisite: generate...");
    const genResult = await runGenerateTest(testDir, config, ctx);
    steps.push(...genResult.steps);
    if (!genResult.success) {
      return { steps, success: false };
    }
  }

  console.log("🧪 Testing drizzle-kit migrate...");
  const migrateResult = await testDrizzleKitMigrate(testDir, config);
  steps.push(migrateResult);

  if (!migrateResult.success) {
    console.log(`  ❌ Failed: ${migrateResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Migrate command works");

  // Verify DB schema
  console.log("🔎 Verifying migrated DB schema...");
  const verifyDbResult = await verifyDatabaseSchema(testDir, config, config.verifyArgs.migrate);
  steps.push(verifyDbResult);

  if (!verifyDbResult.success) {
    console.log(`  ❌ Failed: ${verifyDbResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ DB schema verified");
  ctx.migratedDb = true;

  return { steps, success: true };
}

async function runPushTest(
  testDir: string,
  config: DialectConfig,
  ctx: TestContext
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];

  console.log("🧪 Testing drizzle-kit push...");
  const pushResult = await testDrizzleKitPush(testDir, config);
  steps.push(pushResult);

  if (!pushResult.success) {
    console.log(`  ❌ Failed: ${pushResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Push command works");

  // Verify push DB schema
  console.log("🔎 Verifying push DB schema...");
  const verifyPushDbResult = await verifyPushDatabaseSchema(testDir, config, config.verifyArgs.push);
  steps.push(verifyPushDbResult);

  if (!verifyPushDbResult.success) {
    console.log(`  ❌ Failed: ${verifyPushDbResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Push DB schema verified");
  ctx.pushedDb = true;

  return { steps, success: true };
}

async function runPullTest(
  testDir: string,
  config: DialectConfig,
  ctx: TestContext
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];

  // Setup pull DB if config provides setup script
  if (config.setupPullDbTs && config.permissions.setupPullDb) {
    console.log("📋 Creating DB schema (raw SQL)...");
    await Deno.writeTextFile(`${testDir}/setup-pull-db.ts`, config.setupPullDbTs);

    const result = await runCommand(
      ["deno", "run", ...config.permissions.setupPullDb, "./setup-pull-db.ts"],
      { cwd: testDir, timeout: 60_000, env: config.env }
    );

    if (!result.success) {
      return {
        steps: [{ name: "Setup pull DB", success: false, error: result.stderr }],
        success: false,
      };
    }
    console.log("  ✓ DB schema created for pull test");
  } else {
    // For dialects without raw SQL setup, use push first
    if (!ctx.pushedDb) {
      console.log("📋 Running prerequisite: push...");
      const pushResult = await runPushTest(testDir, config, ctx);
      steps.push(...pushResult.steps);
      if (!pushResult.success) {
        return { steps, success: false };
      }
    }
  }

  console.log("🧪 Testing drizzle-kit pull...");
  const pullResult = await testDrizzleKitPull(testDir, config);
  steps.push(pullResult);

  if (!pullResult.success) {
    console.log(`  ❌ Failed: ${pullResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Pull command works");

  // Verify pull generated schema
  console.log("🔎 Verifying pull schema...");
  const verifyPullResult = await verifyPullSchema(testDir, config);
  steps.push(verifyPullResult);

  if (!verifyPullResult.success) {
    console.log(`  ❌ Failed: ${verifyPullResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Pull schema verified");

  return { steps, success: true };
}

type TestRunner = (
  testDir: string,
  config: DialectConfig,
  ctx: TestContext
) => Promise<IndependentTestResult>;

const TEST_RUNNERS: Record<TestName, TestRunner> = {
  help: runHelpTest,
  generate: runGenerateTest,
  migrate: runMigrateTest,
  push: runPushTest,
  pull: runPullTest,
};

// =============================================================================
// Main Test Version Function
// =============================================================================

async function testVersion(
  config: DialectConfig,
  version: string,
  options: { quick?: boolean; tests?: TestName[] } = {}
): Promise<TestResult> {
  const startTime = Date.now();
  const steps: StepResult[] = [];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Testing drizzle-kit@${version} with ${config.displayName}`);
  console.log(`${"═".repeat(60)}`);

  // Step 1: Setup test environment
  console.log("\n📁 Setting up test environment...");
  const testDir = await setupTestEnvironment(config, version);
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

  // Step 5: Verify patch marker (if configured)
  if (config.patchMarker) {
    console.log("🔍 Verifying patch marker...");
    const markerResult = await verifyPatchMarker(testDir, config.patchMarker);
    steps.push(markerResult);
    if (!markerResult.success) {
      console.log(`  ❌ Failed: ${markerResult.error}`);
      return { version, steps, duration: Date.now() - startTime, success: false };
    }
    console.log("  ✓ Patch marker verified");
  }

  // Step 6: Verify all patches (if configured)
  if (config.criticalPatches && config.criticalPatches.length > 0) {
    console.log("🔬 Verifying all patches applied...");
    const allPatchesResult = await verifyAllPatches(
      testDir,
      config.criticalPatches,
      config.optionalPatches || []
    );
    steps.push(allPatchesResult);
    if (!allPatchesResult.success) {
      console.log(`  ❌ Failed: ${allPatchesResult.error}`);
      if (allPatchesResult.output) {
        console.log(`  ${allPatchesResult.output}`);
      }
      return { version, steps, duration: Date.now() - startTime, success: false };
    }
    console.log(`  ✓ All patches verified (${allPatchesResult.output})`);
  }

  // Run tests unless quick mode
  if (!options.quick) {
    const ctx = createTestContext();
    const testsToRun = options.tests || [...AVAILABLE_TESTS];
    const testList = testsToRun.join(", ");
    console.log(`\n📋 Running tests: ${testList}`);

    for (const testName of testsToRun) {
      const runner = TEST_RUNNERS[testName];
      const result = await runner(testDir, config, ctx);
      steps.push(...result.steps);

      if (!result.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `\n✅ drizzle-kit@${version} passed all tests (${(duration / 1000).toFixed(1)}s)`
  );

  return { version, steps, duration, success: true };
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function cleanup(testDir: string) {
  console.log("\n🧹 Cleaning up test directory...");
  try {
    await Deno.remove(testDir, { recursive: true });
    console.log("  ✓ Cleanup complete");
  } catch {
    console.log("  ⚠ No cleanup needed");
  }
}

export async function runTests(config: DialectConfig) {
  const args = parseArgs(Deno.args, {
    boolean: ["quick", "keep", "help"],
    string: ["test"],
    alias: { q: "quick", k: "keep", h: "help", t: "test" },
  });

  if (args.help) {
    console.log(`
drizzle-kit Patch Test Suite (${config.displayName})

Usage:
  deno task test:${config.name === "pgsql" ? "pglite" : "libsql"} [options] [versions...]

Options:
  --quick, -q        Quick test (only verify patch applies, skip runtime tests)
  --test, -t <tests> Run specific tests (comma-separated: help,generate,migrate,push,pull)
  --keep, -k         Keep test directories after completion
  --help, -h         Show this help message

Available Tests:
  help      Test --help command
  generate  Test schema generation (creates migrations)
  migrate   Test database migration (runs generate first if needed)
  push      Test schema push (standalone, uses --force)
  pull      Test schema introspection

Examples:
  deno task test:${config.name === "pgsql" ? "pglite" : "libsql"}                    # Test all supported versions
  deno task test:${config.name === "pgsql" ? "pglite" : "libsql"} 0.30.6             # Test a specific version
  deno task test:${config.name === "pgsql" ? "pglite" : "libsql"} --quick            # Quick test all versions
  deno task test:${config.name === "pgsql" ? "pglite" : "libsql"} --test=push        # Run only push test
`);
    Deno.exit(0);
  }

  // Parse --test option
  let testsToRun: TestName[] | undefined;
  if (args.test) {
    const requestedTests = args.test.split(",").map((t: string) => t.trim().toLowerCase());
    const invalidTests = requestedTests.filter((t: string) => !AVAILABLE_TESTS.includes(t as TestName));
    if (invalidTests.length > 0) {
      console.error(`❌ Invalid test(s): ${invalidTests.join(", ")}`);
      console.error(`   Available: ${AVAILABLE_TESTS.join(", ")}`);
      Deno.exit(1);
    }
    testsToRun = requestedTests as TestName[];
  }

  // Determine versions
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
  console.log(`║        drizzle-kit Patch Test Suite (${config.displayName.padEnd(17)}) ║`);
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nVersions to test: ${versionsToTest.join(", ")}`);
  if (testsToRun) {
    console.log(`Tests to run: ${testsToRun.join(", ")}`);
  }
  console.log(`Mode: ${args.quick ? "Quick (patch only)" : "Full (patch + runtime)"}`);

  const results: TestResult[] = [];

  for (const version of versionsToTest) {
    const result = await testVersion(config, version, { quick: args.quick, tests: testsToRun });
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
  console.log(`Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);

  // Cleanup unless --keep flag
  if (!args.keep) {
    await cleanup(config.testDir);
  } else {
    console.log(`\n📁 Test directories kept at: ${config.testDir}/`);
  }

  // Exit with appropriate code
  if (failed.length > 0) {
    console.log("\n❌ Some tests failed");
    Deno.exit(1);
  }

  console.log("\n✅ All tests passed!");
  Deno.exit(0);
}
