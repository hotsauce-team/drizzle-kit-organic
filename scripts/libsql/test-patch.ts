#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Test suite for drizzle-kit patch compatibility with SQLite/LibSQL.
 *
 * Tests that the patched drizzle-kit binary works with the libsql driver.
 *
 * Usage:
 *   deno task test:patch:sqlite              # Test all supported versions
 *   deno task test:patch:sqlite 0.30.6       # Test a specific version
 *   deno task test:patch:sqlite --test=help  # Run only help test
 */

import { walk } from "@std/fs/walk";
import { parseArgs } from "@std/cli/parse-args";

// Supported versions to test (should match SUPPORTED_VERSIONS in patch-drizzle-kit.ts)
const SUPPORTED_VERSIONS = ["0.30.6", "0.31.8", "0.31.9"];

// Available command tests
const AVAILABLE_TESTS = ["help", "generate", "migrate", "push", "pull"] as const;
type TestName = (typeof AVAILABLE_TESTS)[number];

// Test configuration
const TEST_DIR = ".test-patch-sqlite";
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
      "@libsql/client": "npm:@libsql/client@^0.14.0",
      "libsql": "npm:libsql@^0.4.7",
      "@std/fs": "jsr:@std/fs@1",
    },
    nodeModulesDir: "auto",
  };

  await Deno.writeTextFile(
    `${versionDir}/deno.jsonc`,
    JSON.stringify(denoConfig, null, 2)
  );

  // Create a minimal SQLite schema for testing
  const schema = `
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});
`;
  await Deno.writeTextFile(`${versionDir}/schema.ts`, schema);

  // Create a minimal drizzle config for libsql
  const config = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./data.db",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle.config.ts`, config);

  // Create push-specific config that uses separate DB
  const pushConfig = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./data-push.db",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle-push.config.ts`, pushConfig);

  // Create pull-specific config that reads from push DB and outputs to drizzle-pull
  const pullConfig = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-pull",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./data-push.db",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle-pull.config.ts`, pullConfig);

  // Create drizzle output directory
  await Deno.mkdir(`${versionDir}/drizzle`, { recursive: true });

  // Copy DB verification script into the test environment
  const verifyDbScript = await Deno.readTextFile("scripts/libsql/verify-db.ts");
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
      patchScript
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
      "--allow-read=.",
      "--allow-write=./node_modules",
      "./scripts/patch-drizzle-kit.ts",
    ],
    { cwd: testDir, timeout: 30_000 }
  );

  const output = result.stdout + result.stderr;
  // Check for success message or "already patched" message
  const success =
    result.success &&
    (output.includes("Patched drizzle-kit successfully") ||
      output.includes("already patched"));

  return {
    name: "Run patch script",
    success,
    error: success ? undefined : result.stderr || "Patch did not report success",
    output: output.slice(0, 1000),
  };
}

async function testDrizzleKitHelp(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit --help works
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=.,./node_modules",
      "./node_modules/drizzle-kit/bin.cjs",
      "--help",
    ],
    { cwd: testDir, timeout: 30_000 }
  );

  const output = result.stdout + result.stderr;
  // Check for typical drizzle-kit help output
  const hasHelpOutput =
    output.includes("drizzle-kit") &&
    (output.includes("generate") || output.includes("push") || output.includes("pull"));

  return {
    name: "Test drizzle-kit --help",
    success: result.success && hasHelpOutput,
    error:
      result.success && hasHelpOutput
        ? undefined
        : result.stderr || "Help output not as expected",
    output: output.slice(0, 500),
  };
}

async function testDrizzleKitGenerate(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit generate works (reads config and schema)
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=.,./node_modules",
      "--allow-write=./drizzle",
      "./node_modules/drizzle-kit/bin.cjs",
      "generate",
    ],
    { cwd: testDir, timeout: 60_000 }
  );

  const output = result.stdout + result.stderr;
  // Success if it generated migrations or said no changes needed
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

async function testDrizzleKitMigrate(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit migrate works (applies migrations to SQLite DB)
  // LIBSQL_JS_NODE=1 tells patched drizzle-kit to use @libsql/client/node for file: URLs
  // --allow-ffi needed for libsql native bindings
  // --allow-sys needed on Linux for glibc detection
  // --allow-env needed for libsql internal env checks
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal,./drizzle",
      "--allow-ffi",
      "./node_modules/drizzle-kit/bin.cjs",
      "migrate",
    ],
    { cwd: testDir, timeout: 60_000, env: { LIBSQL_JS_NODE: "1" } }
  );

  const output = result.stdout + result.stderr;
  // Be permissive about success wording across versions
  const success = result.success && !output.toLowerCase().includes("error");

  return {
    name: "Test drizzle-kit migrate",
    success,
    error: success ? undefined : result.stderr || "Migrate command failed",
    output: output.slice(0, 500),
  };
}

async function verifyDatabaseSchema(testDir: string): Promise<StepResult> {
  // Verify DB schema created by migrate
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal",
      "--allow-ffi",
      "./verify-db.ts",
      "--db", "./data.db",
    ],
    { cwd: testDir, timeout: 30_000 }
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

async function testDrizzleKitPush(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit push works (pushes schema directly to DB)
  // Uses separate DB so it doesn't interfere with migrate tests
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal,./drizzle",
      "--allow-ffi",
      "./node_modules/drizzle-kit/bin.cjs",
      "push",
      "--config=drizzle-push.config.ts",
      "--force",
    ],
    { cwd: testDir, timeout: 60_000, env: { LIBSQL_JS_NODE: "1" } }
  );

  // Trust exit code; DB verification is the real correctness check
  return {
    name: "Test drizzle-kit push",
    success: result.success,
    error: result.success ? undefined : result.stderr || "Push command failed",
    output: (result.stdout + result.stderr).slice(0, 500),
  };
}

async function verifyPushDatabaseSchema(testDir: string): Promise<StepResult> {
  // Verify DB schema created by push (uses separate data-push.db)
  // Note: push doesn't create __drizzle_migrations table, so we skip that check
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal",
      "--allow-ffi",
      "./verify-db.ts",
      "--db", "./data-push.db",
      "--skip-migrations",
    ],
    { cwd: testDir, timeout: 30_000 }
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

async function testDrizzleKitPull(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit pull works (introspects DB and generates schema)
  // Uses push DB which has schema from previous push test
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces",
      "--allow-read=.,./node_modules",
      "--allow-write=./drizzle-pull",
      "--allow-ffi",
      "./node_modules/drizzle-kit/bin.cjs",
      "pull",
      "--config=drizzle-pull.config.ts",
    ],
    { cwd: testDir, timeout: 60_000, env: { LIBSQL_JS_NODE: "1" } }
  );

  // Trust exit code; output verification is the real correctness check
  return {
    name: "Test drizzle-kit pull",
    success: result.success,
    error: result.success ? undefined : result.stderr || "Pull command failed",
    output: (result.stdout + result.stderr).slice(0, 500),
  };
}

async function verifyPullOutput(testDir: string): Promise<StepResult> {
  // Verify that pull created schema file(s) in drizzle-pull/
  const pullDir = `${testDir}/drizzle-pull`;
  
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(pullDir)) {
      entries.push(entry.name);
    }
    
    // Should have schema.ts and possibly relations.ts
    const hasSchemaFile = entries.some(e => e.endsWith(".ts") && e.includes("schema"));
    
    if (!hasSchemaFile) {
      return {
        name: "Verify pull output",
        success: false,
        error: `Expected schema file in drizzle-pull/, found: ${entries.join(", ") || "<empty>"}`,
        output: "",
      };
    }
    
    // Read schema file to verify it contains users table
    const schemaFile = entries.find(e => e.endsWith(".ts") && e.includes("schema"))!;
    const schemaContent = await Deno.readTextFile(`${pullDir}/${schemaFile}`);
    
    if (!schemaContent.includes("users")) {
      return {
        name: "Verify pull output",
        success: false,
        error: "Schema file missing 'users' table definition",
        output: schemaContent.slice(0, 300),
      };
    }
    
    return {
      name: "Verify pull output",
      success: true,
      output: `Found ${entries.length} file(s): ${entries.join(", ")}`,
    };
  } catch (e) {
    return {
      name: "Verify pull output",
      success: false,
      error: `Failed to read drizzle-pull/: ${e}`,
      output: "",
    };
  }
}

async function testVersion(
  version: string,
  options: { tests?: TestName[] } = {}
): Promise<TestResult> {
  const startTime = Date.now();
  const steps: StepResult[] = [];

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Testing drizzle-kit@${version} with SQLite/LibSQL`);
  console.log("─".repeat(60));

  // Setup
  console.log("  📁 Setting up test environment...");
  const testDir = await setupTestEnvironment(version);
  steps.push({ name: "Setup test environment", success: true });

  // Install dependencies
  console.log("  📦 Installing dependencies...");
  const installResult = await installDependencies(testDir);
  steps.push(installResult);
  if (!installResult.success) {
    return {
      version,
      steps,
      duration: Date.now() - startTime,
      success: false,
    };
  }

  // Copy patch script
  console.log("  📋 Copying patch script...");
  const copyResult = await copyPatchScript(testDir);
  steps.push(copyResult);
  if (!copyResult.success) {
    return {
      version,
      steps,
      duration: Date.now() - startTime,
      success: false,
    };
  }

  // Run patch
  console.log("  🔧 Running patch script...");
  const patchResult = await runPatchScript(testDir);
  steps.push(patchResult);
  if (!patchResult.success) {
    return {
      version,
      steps,
      duration: Date.now() - startTime,
      success: false,
    };
  }

  // Determine which tests to run
  const testsToRun = options.tests ?? [...AVAILABLE_TESTS];

  // Run selected tests
  for (const testName of testsToRun) {
    if (testName === "help") {
      console.log("  🧪 Testing drizzle-kit --help...");
      const helpResult = await testDrizzleKitHelp(testDir);
      steps.push(helpResult);
      if (!helpResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }
    }

    if (testName === "generate") {
      console.log("  🧪 Testing drizzle-kit generate...");
      const generateResult = await testDrizzleKitGenerate(testDir);
      steps.push(generateResult);
      if (!generateResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }
    }

    if (testName === "migrate") {
      // migrate requires generate to run first
      if (!testsToRun.includes("generate")) {
        console.log("  🧪 Running prerequisite: drizzle-kit generate...");
        const generateResult = await testDrizzleKitGenerate(testDir);
        steps.push(generateResult);
        if (!generateResult.success) {
          return {
            version,
            steps,
            duration: Date.now() - startTime,
            success: false,
          };
        }
      }

      console.log("  🧪 Testing drizzle-kit migrate...");
      const migrateResult = await testDrizzleKitMigrate(testDir);
      steps.push(migrateResult);
      if (!migrateResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }

      console.log("  🔍 Verifying database schema...");
      const verifyResult = await verifyDatabaseSchema(testDir);
      steps.push(verifyResult);
      if (!verifyResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }
    }

    if (testName === "push") {
      console.log("  🧪 Testing drizzle-kit push...");
      const pushResult = await testDrizzleKitPush(testDir);
      steps.push(pushResult);
      if (!pushResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }

      console.log("  🔍 Verifying push database schema...");
      const verifyPushResult = await verifyPushDatabaseSchema(testDir);
      steps.push(verifyPushResult);
      if (!verifyPushResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }
    }

    if (testName === "pull") {
      // pull requires push to run first to have a DB to introspect
      if (!testsToRun.includes("push")) {
        console.log("  🧪 Running prerequisite: drizzle-kit push...");
        const pushResult = await testDrizzleKitPush(testDir);
        steps.push(pushResult);
        if (!pushResult.success) {
          return {
            version,
            steps,
            duration: Date.now() - startTime,
            success: false,
          };
        }
      }

      console.log("  🧪 Testing drizzle-kit pull...");
      const pullResult = await testDrizzleKitPull(testDir);
      steps.push(pullResult);
      if (!pullResult.success) {
        return {
          version,
          steps,
          duration: Date.now() - startTime,
          success: false,
        };
      }

      console.log("  🔍 Verifying pull output...");
      const verifyPullOutput_ = await verifyPullOutput(testDir);
      steps.push(verifyPullOutput_);
      if (!verifyPullOutput_.success) {
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
  console.log(`  ✅ All tests passed for ${version} (${(duration / 1000).toFixed(1)}s)`);

  return {
    version,
    steps,
    duration,
    success: true,
  };
}

async function cleanup() {
  try {
    await Deno.remove(TEST_DIR, { recursive: true });
    console.log(`\n🧹 Cleaned up test directory: ${TEST_DIR}`);
  } catch {
    // Directory may not exist
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["test"],
    boolean: ["keep"],
    default: {
      keep: false,
    },
  });

  // Parse version argument (first positional arg)
  const versionArg = args._[0]?.toString();
  const versionsToTest = versionArg ? [versionArg] : SUPPORTED_VERSIONS;

  // Parse --test flag
  let testsToRun: TestName[] | undefined;
  if (args.test) {
    const requestedTests = args.test.split(",").map((t) => t.trim());
    testsToRun = requestedTests.filter((t): t is TestName =>
      AVAILABLE_TESTS.includes(t as TestName)
    );
    if (testsToRun.length === 0) {
      console.error(`Invalid tests: ${args.test}`);
      console.error(`Available tests: ${AVAILABLE_TESTS.join(", ")}`);
      Deno.exit(1);
    }
  }

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     DRIZZLE-KIT SQLITE/LIBSQL PATCH TEST SUITE             ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nVersions to test: ${versionsToTest.join(", ")}`);
  if (testsToRun) {
    console.log(`Tests to run: ${testsToRun.join(", ")}`);
  }

  const results: TestResult[] = [];

  for (const version of versionsToTest) {
    const result = await testVersion(version, { tests: testsToRun });
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
    `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`
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
