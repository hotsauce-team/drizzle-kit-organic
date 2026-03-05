/**
 * SQLite/LibSQL dialect configuration for drizzle-kit patch tests.
 */

import type { DialectConfig } from "../shared/types.ts";

// Schema file content
const schemaTs = `
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});
`;

// Main config
const configTs = `
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

// Push config (uses separate DB)
const pushConfigTs = `
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

// Pull config (reads from push DB, outputs to drizzle-pull)
const pullConfigTs = `
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-pull",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./data-push.db",
  },
});
`;

// Verify pull schema contains expected SQLite structure
function verifyPullSchema(
  content: string,
): { success: boolean; error?: string } {
  // Should have users table definition
  if (!content.includes("users")) {
    return {
      success: false,
      error: "Schema file missing 'users' table definition",
    };
  }

  // Should be SQLite (not PostgreSQL)
  if (content.includes("pgTable") || content.includes("drizzle-orm/pg-core")) {
    return { success: false, error: "Schema should be SQLite, not PostgreSQL" };
  }

  // Should have sqliteTable
  if (!content.includes("sqliteTable") && !content.includes("sqlite-core")) {
    return {
      success: false,
      error: "Schema should use sqliteTable from drizzle-orm/sqlite-core",
    };
  }

  return { success: true };
}

export const libsqlConfig: DialectConfig = {
  name: "libsql",
  displayName: "SQLite/LibSQL",
  testDir: ".test-patch-sqlite",

  dependencies: {
    "@libsql/client": "npm:@libsql/client@^0.14.0",
    libsql: "npm:libsql@^0.4.7",
  },

  schemaTs,
  configTs,
  pushConfigTs,
  pullConfigTs,
  verifyDbPath: "scripts/libsql/verify-db.ts",

  // No setupPullDbTs - libsql uses push as prerequisite for pull

  dirs: ["drizzle", "drizzle-pull"],

  permissions: {
    help: ["--allow-read=.,./node_modules"],
    generate: ["--allow-read=.,./node_modules", "--allow-write=./drizzle"],
    migrate: [
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces,hostname",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal,./drizzle",
      "--allow-ffi=./node_modules/.deno",
    ],
    verifyMigrate: [
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces,hostname",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal",
      "--allow-ffi=./node_modules/.deno",
    ],
    push: [
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces,hostname",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal,./drizzle",
      "--allow-ffi=./node_modules/.deno",
    ],
    verifyPush: [
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces,hostname",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal",
      "--allow-ffi=./node_modules/.deno",
    ],
    pull: [
      "--allow-env",
      "--allow-sys=cpus,networkInterfaces,hostname",
      "--allow-read=.,./node_modules",
      "--allow-write=./drizzle-pull",
      "--allow-ffi=./node_modules/.deno",
    ],
  },

  env: { LIBSQL_JS_NODE: "1" },

  // No patch verification for libsql (pgsql handles that)

  verifyArgs: {
    migrate: ["--db", "./data.db"],
    push: ["--db", "./data-push.db", "--skip-migrations"],
  },

  verifyPullSchema,
};
