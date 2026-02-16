#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Test suite for drizzle-kit patch compatibility across versions.
 *
 * Tests that the patch script successfully patches different versions of drizzle-kit
 * and that the patched binary can execute basic commands.
 *
 * Usage:
 *   deno task test:patch                    # Test all supported versions
 *   deno task test:patch 0.30.6             # Test a specific version
 *   deno task test:patch --quick            # Quick test (only checks patch applies)
 *   deno task test:patch --test=push        # Run only push test (with prerequisites)
 *   deno task test:patch --test=pull,push   # Run specific tests
 *
 * Each command test is independent and handles its own prerequisites:
 *   - help:     No prerequisites
 *   - generate: No prerequisites
 *   - migrate:  Runs generate first
 *   - push:     No prerequisites (uses schema.ts directly)
 *   - pull:     Creates DB via raw SQL (no drizzle-kit dependency)
 */

import { walk } from "@std/fs/walk";
import { parseArgs } from "@std/cli/parse-args";

// Supported versions to test (should match SUPPORTED_VERSIONS in patch-drizzle-kit.ts)
const SUPPORTED_VERSIONS = ["0.30.6", "0.31.8", "0.31.9"];

// Available command tests (can be run independently with --test flag)
const AVAILABLE_TESTS = ["help", "generate", "migrate", "push", "pull"] as const;
type TestName = typeof AVAILABLE_TESTS[number];

// Test configuration
const TEST_DIR = ".test-patch";
const TIMEOUT_MS = 120_000; // 2 minutes per version

// Track what's been set up in the current test run to avoid duplicate work
interface TestContext {
  generatedMigrations: boolean;
  migratedDb: boolean;
  pushedDb: boolean;
}

function createTestContext(): TestContext {
  return {
    generatedMigrations: false,
    migratedDb: false,
    pushedDb: false,
  };
}

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

  // Create separate DB directory for push testing (DB is isolated, but shares out/ for schema snapshot)
  await Deno.mkdir(`${versionDir}/data-push`, { recursive: true });

  // Create push-specific config that uses separate DB but same out/ directory
  // (push reads schema snapshot from out/ created by generate)
  const pushConfig = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  driver: "pglite" as const,
  dbCredentials: {
    url: "file:./data-push",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle-push.config.ts`, pushConfig);

  // Create pull-specific config with its own DB and output directory (fully independent)
  await Deno.mkdir(`${versionDir}/drizzle-pull`, { recursive: true });
  await Deno.mkdir(`${versionDir}/data-pull`, { recursive: true });
  const pullConfig = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-pull",
  dialect: "postgresql",
  driver: "pglite" as const,
  dbCredentials: {
    url: "file:./data-pull",
  },
});
`;
  await Deno.writeTextFile(`${versionDir}/drizzle-pull.config.ts`, pullConfig);

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
        const hasMarker = content.includes("DRIZZLE-KIT-DENO-PATCHED-V11");

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
  {
    name: "minimatch testing env",
    pattern: "/* PATCHED: skip __MINIMATCH_TESTING_PLATFORM__ for Deno */",
  },
  {
    name: "TEST_CONFIG_PATH_PREFIX",
    pattern: "/* PATCHED: skip TEST_CONFIG_PATH_PREFIX for Deno */",
  },
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
      "--allow-read=.,./node_modules",
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
      "--allow-env=DATABASE_URL",
      "--allow-read=.,./node_modules",
      "--allow-write=./drizzle",
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
      "--allow-env=DATABASE_URL",
      "--allow-read=.,./node_modules",
      "--allow-write=./data,./drizzle",
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

async function testDrizzleKitPush(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit push works (pushes schema directly to DB)
  // Uses separate DB but shared out/ directory (push reads schema snapshot from generate)
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env=DATABASE_URL",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push,./drizzle",
      "./node_modules/drizzle-kit/bin.cjs",
      "push",
      "--config=drizzle-push.config.ts",
      "--force",
    ],
    { cwd: testDir, timeout: 60_000 },
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
  // Verify DB schema created by push (uses separate data-push directory)
  // Note: push doesn't create __drizzle_migrations table, so we skip that check
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push",
      "./verify-db.ts",
      "--db", "./data-push",
      "--skip-migrations", // push doesn't record migrations
    ],
    { cwd: testDir, timeout: 30_000 },
  );

  const output = result.stdout + result.stderr;
  const success = result.success && output.includes("Verified DB schema");

  return {
    name: "Verify push DB schema",
    success,
    error: success ? undefined : result.stderr || "Push DB schema verification failed",
    output: result.stdout.slice(0, 500),
  };
}

async function verifyDatabaseSchema(testDir: string): Promise<StepResult> {
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=.,./node_modules",
      "--allow-write=./data",
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

async function testDrizzleKitPull(testDir: string): Promise<StepResult> {
  // Test that drizzle-kit pull works (introspects DB and generates schema)
  // Uses dedicated data-pull database created via raw SQL
  // Note: needs write access to data-pull for PGlite database locks
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-env=DATABASE_URL",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-pull,./drizzle-pull",
      "./node_modules/drizzle-kit/bin.cjs",
      "pull",
      "--config=drizzle-pull.config.ts",
    ],
    { cwd: testDir, timeout: 60_000 },
  );

  // Trust exit code; schema verification is the real correctness check
  return {
    name: "Test drizzle-kit pull",
    success: result.success,
    error: result.success ? undefined : result.stderr || "Pull command failed",
    output: (result.stdout + result.stderr).slice(0, 500),
  };
}

async function verifyPullSchema(testDir: string): Promise<StepResult> {
  // Verify that pull generated a schema file with expected tables
  try {
    const schemaPath = `${testDir}/drizzle-pull/schema.ts`;
    
    // Check file exists and read content
    let content: string;
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(schemaPath);
      content = await Deno.readTextFile(schemaPath);
    } catch {
      return {
        name: "Verify pull schema",
        success: false,
        error: `Schema file not found at ${schemaPath}`,
      };
    }
    
    // Assert file is non-trivial (> 200 bytes)
    if (stat.size < 200) {
      return {
        name: "Verify pull schema",
        success: false,
        error: `Schema file too small (${stat.size} bytes), expected > 200`,
        output: content,
      };
    }
    
    // Assert it's for PostgreSQL (not SQLite or other dialects)
    const hasPgImport = content.includes('drizzle-orm/pg-core') && content.includes('pgTable');
    const hasSqliteImport = content.includes('sqliteTable');
    if (!hasPgImport || hasSqliteImport) {
      return {
        name: "Verify pull schema",
        success: false,
        error: "Schema should import pgTable from drizzle-orm/pg-core, not SQLite",
        output: content.slice(0, 500),
      };
    }
    
    // Assert no empty schema fallback
    const emptySchemaPatterns = ['No tables found', 'empty schema', 'no tables'];
    for (const pattern of emptySchemaPatterns) {
      if (content.toLowerCase().includes(pattern.toLowerCase())) {
        return {
          name: "Verify pull schema",
          success: false,
          error: `Schema appears to be empty (contains "${pattern}")`,
          output: content.slice(0, 500),
        };
      }
    }
    
    // Assert users table with proper structure
    // Look for: pgTable("users" or export const users = pgTable(
    const hasUsersTableDef = /pgTable\(["']users["']/.test(content) || 
                             /export const users\s*=\s*pgTable\(/.test(content);
    // Look for id column with serial and primaryKey
    // Format 1: serial("id").primaryKey() - explicit column name
    // Format 2: id: serial().primaryKey() - column name from object key
    const hasIdColumn = /serial\(["']id["']\).*\.primaryKey\(\)/.test(content) ||
                        /id:\s*serial\(\)\.primaryKey\(\)/.test(content);
    // Look for name column with text and notNull
    // Format 1: text("name").notNull()
    // Format 2: name: text().notNull()
    const hasNameColumn = /text\(["']name["']\).*\.notNull\(\)/.test(content) ||
                          /name:\s*text\(\)\.notNull\(\)/.test(content);
    
    if (!hasUsersTableDef || !hasIdColumn || !hasNameColumn) {
      return {
        name: "Verify pull schema",
        success: false,
        error: `Users table missing expected structure: tableDef=${hasUsersTableDef}, idCol=${hasIdColumn}, nameCol=${hasNameColumn}`,
        output: content.slice(0, 800),
      };
    }
    
    // Assert posts table exists (catches "pull ran but didn't introspect" failures)
    const hasPostsTableDef = /pgTable\(["']posts["']/.test(content) ||
                             /export const posts\s*=\s*pgTable\(/.test(content);
    // Posts should have title and user_id columns
    // title: text().notNull() or text("title").notNull()
    const hasPostsTitle = /text\(["']title["']\)/.test(content) ||
                          /title:\s*text\(\)\.notNull\(\)/.test(content);
    // user_id uses explicit name since camelCase key differs: integer("user_id")
    const hasPostsUserId = /integer\(["']user_id["']\)/.test(content);
    
    if (!hasPostsTableDef || !hasPostsTitle || !hasPostsUserId) {
      return {
        name: "Verify pull schema",
        success: false,
        error: `Posts table missing expected structure: tableDef=${hasPostsTableDef}, titleCol=${hasPostsTitle}, userIdCol=${hasPostsUserId}`,
        output: content.slice(0, 800),
      };
    }
    
    return {
      name: "Verify pull schema",
      success: true,
      output: `Generated schema contains users table (id, name) and posts table (id, title, user_id) from drizzle-orm/pg-core`,
    };
  } catch (error) {
    return {
      name: "Verify pull schema",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// =============================================================================
// Independent Test Runners
// Each test handles its own prerequisites and can be run standalone
// =============================================================================

interface IndependentTestResult {
  steps: StepResult[];
  success: boolean;
}

async function runHelpTest(
  testDir: string,
  _ctx: TestContext,
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];
  
  console.log("🧪 Testing drizzle-kit --help...");
  const helpResult = await testDrizzleKitHelp(testDir);
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
  ctx: TestContext,
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];
  
  console.log("🧪 Testing drizzle-kit generate...");
  const generateResult = await testDrizzleKitGenerate(testDir);
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
  ctx: TestContext,
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];
  
  // Prerequisite: generate migrations first
  if (!ctx.generatedMigrations) {
    console.log("📋 Running prerequisite: generate...");
    const genResult = await runGenerateTest(testDir, ctx);
    steps.push(...genResult.steps);
    if (!genResult.success) {
      return { steps, success: false };
    }
  }
  
  console.log("🧪 Testing drizzle-kit migrate...");
  const migrateResult = await testDrizzleKitMigrate(testDir);
  steps.push(migrateResult);
  
  if (!migrateResult.success) {
    console.log(`  ❌ Failed: ${migrateResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Migrate command works");
  
  // Verify DB schema
  console.log("🔎 Verifying migrated DB schema...");
  const verifyDbResult = await verifyDatabaseSchema(testDir);
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
  ctx: TestContext,
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];
  
  // No prerequisites - push reads schema.ts directly and uses --force
  console.log("🧪 Testing drizzle-kit push...");
  const pushResult = await testDrizzleKitPush(testDir);
  steps.push(pushResult);
  
  if (!pushResult.success) {
    console.log(`  ❌ Failed: ${pushResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Push command works");
  
  // Verify push DB schema
  console.log("🔎 Verifying push DB schema...");
  const verifyPushDbResult = await verifyPushDatabaseSchema(testDir);
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
  _ctx: TestContext,
): Promise<IndependentTestResult> {
  const steps: StepResult[] = [];
  
  // Always create DB schema via raw SQL (fully independent test)
  console.log("📋 Creating DB schema (raw SQL)...");
  await ensurePullDbSchema(testDir);
  
  console.log("🧪 Testing drizzle-kit pull...");
  const pullResult = await testDrizzleKitPull(testDir);
  steps.push(pullResult);
  
  if (!pullResult.success) {
    console.log(`  ❌ Failed: ${pullResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Pull command works");
  
  // Verify pull generated schema
  console.log("🔎 Verifying pull schema...");
  const verifyPullResult = await verifyPullSchema(testDir);
  steps.push(verifyPullResult);
  
  if (!verifyPullResult.success) {
    console.log(`  ❌ Failed: ${verifyPullResult.error}`);
    return { steps, success: false };
  }
  console.log("  ✓ Pull schema verified");
  
  return { steps, success: true };
}

// Helper: Create DB schema for pull test using raw SQL (no drizzle-kit dependency)
async function ensurePullDbSchema(testDir: string): Promise<void> {
  // Create a script that uses PGlite directly with raw SQL
  // Creates TWO tables (users + posts) to ensure pull actually introspects the DB
  // and isn't just returning a template/default schema
  const setupScript = `
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite("./data-pull");

// Create the users table with raw SQL
await db.exec(\`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
  );
\`);

// Create a posts table that references users (proves introspection is real)
await db.exec(\`
  CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
\`);

// Verify both tables were created
const result = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
const tables = result.rows.map((r: { tablename: string }) => r.tablename);
if (!tables.includes("users")) {
  throw new Error("Failed to create users table");
}
if (!tables.includes("posts")) {
  throw new Error("Failed to create posts table");
}

console.log("Created users and posts tables via raw SQL");
await db.close();
`;
  await Deno.writeTextFile(`${testDir}/setup-pull-db.ts`, setupScript);
  
  // Run the setup script
  const result = await runCommand(
    [
      "deno",
      "run",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-pull",
      "./setup-pull-db.ts",
    ],
    { cwd: testDir, timeout: 60_000 },
  );
  
  if (!result.success) {
    throw new Error(`Failed to setup DB for pull test: ${result.stderr}`);
  }
  console.log("  ✓ DB schema created for pull test (users + posts tables via raw SQL)");
}

// Map test names to their runner functions
const TEST_RUNNERS: Record<TestName, (testDir: string, ctx: TestContext) => Promise<IndependentTestResult>> = {
  help: runHelpTest,
  generate: runGenerateTest,
  migrate: runMigrateTest,
  push: runPushTest,
  pull: runPullTest,
};

async function testVersion(
  version: string,
  options: { quick?: boolean; tests?: TestName[] } = {},
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
    // Create test context to track prerequisites across tests
    const ctx = createTestContext();
    
    // Determine which tests to run
    const testsToRun = options.tests || AVAILABLE_TESTS.slice(); // default: all tests
    const testList = testsToRun.join(", ");
    console.log(`\n📋 Running tests: ${testList}`);
    
    // Run selected tests using independent test runners
    for (const testName of testsToRun) {
      const runner = TEST_RUNNERS[testName];
      const result = await runner(testDir, ctx);
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
    string: ["test"],
    alias: { q: "quick", k: "keep", h: "help", t: "test" },
  });

  if (args.help) {
    console.log(`
drizzle-kit Patch Test Suite

Usage:
  deno task test:patch [options] [versions...]

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
  pull      Test schema introspection (creates DB via raw SQL, standalone)

Examples:
  deno task test:patch                    # Test all supported versions
  deno task test:patch 0.30.6             # Test a specific version
  deno task test:patch --quick            # Quick test all versions
  deno task test:patch --test=push        # Run only push test
  deno task test:patch --test=push,pull   # Run push and pull tests
  deno task test:patch -t migrate 0.31.9  # Test migrate on specific version
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
  if (testsToRun) {
    console.log(`Tests to run: ${testsToRun.join(", ")}`);
  }
  console.log(
    `Mode: ${args.quick ? "Quick (patch only)" : "Full (patch + runtime)"}`,
  );

  const results: TestResult[] = [];

  for (const version of versionsToTest) {
    const result = await testVersion(version, { quick: args.quick, tests: testsToRun });
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
