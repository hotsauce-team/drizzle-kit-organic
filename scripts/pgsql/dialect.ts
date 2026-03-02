/**
 * PostgreSQL (PGlite) dialect configuration for drizzle-kit patch tests.
 */

import type { DialectConfig } from "../shared/types.ts";

// Schema file content
const schemaTs = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
`;

// Main config
const configTs = `
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

// Push config (uses separate DB)
const pushConfigTs = `
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

// Pull config (separate DB + output dir)
const pullConfigTs = `
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

// Setup script for pull test DB (creates tables via raw SQL)
const setupPullDbTs = `
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

// Critical patches that MUST be present
const CRITICAL_PATCHES = [
  {
    name: "walkForTsConfig",
    pattern: "return void 0; // PATCHED: disabled for Deno",
  },
  {
    name: "safeRegister",
    pattern: "return { unregister: () => {} }; // PATCHED: esbuild disabled for Deno",
  },
  { name: "config loading", pattern: "// PATCHED: import for Deno TS support" },
  { name: "CLI exit handler", pattern: "setTimeout(() => process.exit(0), 50)" },
];

// Non-critical patches (may not be present in all versions)
const OPTIONAL_PATCHES = [
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
    pattern: "// PATCHED: Return color level 3 (truecolor) without checking env vars for Deno",
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

// Verify pull schema contains expected PostgreSQL structure
function verifyPullSchema(content: string): { success: boolean; error?: string } {
  // Assert file is non-trivial
  if (content.length < 200) {
    return { success: false, error: `Schema file too small (${content.length} bytes), expected > 200` };
  }

  // Assert it's for PostgreSQL
  const hasPgImport = content.includes("drizzle-orm/pg-core") && content.includes("pgTable");
  const hasSqliteImport = content.includes("sqliteTable");
  if (!hasPgImport || hasSqliteImport) {
    return { success: false, error: "Schema should import pgTable from drizzle-orm/pg-core, not SQLite" };
  }

  // Assert users table with proper structure
  const hasUsersTableDef = /pgTable\(["']users["']/.test(content) ||
    /export const users\s*=\s*pgTable\(/.test(content);
  const hasIdColumn = /serial\(["']id["']\).*\.primaryKey\(\)/.test(content) ||
    /id:\s*serial\(\)\.primaryKey\(\)/.test(content);
  const hasNameColumn = /text\(["']name["']\).*\.notNull\(\)/.test(content) ||
    /name:\s*text\(\)\.notNull\(\)/.test(content);

  if (!hasUsersTableDef || !hasIdColumn || !hasNameColumn) {
    return {
      success: false,
      error: `Users table missing expected structure: tableDef=${hasUsersTableDef}, idCol=${hasIdColumn}, nameCol=${hasNameColumn}`,
    };
  }

  // Assert posts table exists
  const hasPostsTableDef = /pgTable\(["']posts["']/.test(content) ||
    /export const posts\s*=\s*pgTable\(/.test(content);
  const hasPostsTitle = /text\(["']title["']\)/.test(content) ||
    /title:\s*text\(\)\.notNull\(\)/.test(content);
  const hasPostsUserId = /integer\(["']user_id["']\)/.test(content);

  if (!hasPostsTableDef || !hasPostsTitle || !hasPostsUserId) {
    return {
      success: false,
      error: `Posts table missing expected structure: tableDef=${hasPostsTableDef}, titleCol=${hasPostsTitle}, userIdCol=${hasPostsUserId}`,
    };
  }

  return { success: true };
}

export const pgsqlConfig: DialectConfig = {
  name: "pgsql",
  displayName: "PostgreSQL",
  testDir: ".test-patch",

  dependencies: {
    "@electric-sql/pglite": "npm:@electric-sql/pglite@^0.3.15",
    pg: "npm:pg@^8.11.0",
  },

  schemaTs,
  configTs,
  pushConfigTs,
  pullConfigTs,
  verifyDbPath: "scripts/pgsql/verify-db.ts",
  setupPullDbTs,

  dirs: ["drizzle", "data", "data-push", "data-pull", "drizzle-pull"],

  permissions: {
    help: ["--allow-read=.,./node_modules"],
    generate: ["--allow-env=DATABASE_URL", "--allow-read=.,./node_modules", "--allow-write=./drizzle"],
    migrate: ["--allow-env=DATABASE_URL", "--allow-read=.,./node_modules", "--allow-write=./data,./drizzle"],
    verifyMigrate: ["--allow-read=.,./node_modules", "--allow-write=./data"],
    push: ["--allow-env=DATABASE_URL", "--allow-read=.,./node_modules", "--allow-write=./data-push,./drizzle"],
    verifyPush: ["--allow-read=.,./node_modules", "--allow-write=./data-push"],
    pull: ["--allow-env=DATABASE_URL", "--allow-read=.,./node_modules", "--allow-write=./data-pull,./drizzle-pull"],
    setupPullDb: ["--allow-read=.,./node_modules", "--allow-write=./data-pull"],
  },

  patchMarker: "DRIZZLE-KIT-DENO-PATCHED-V12",
  criticalPatches: CRITICAL_PATCHES,
  optionalPatches: OPTIONAL_PATCHES,

  verifyArgs: {
    migrate: ["--db", "./data"],
    push: ["--db", "./data-push", "--skip-migrations"],
  },

  verifyPullSchema,
};
