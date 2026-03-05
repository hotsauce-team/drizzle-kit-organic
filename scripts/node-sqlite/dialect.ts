/**
 * Node SQLite dialect configuration for drizzle-kit patch tests.
 * Uses node:sqlite via @hotsauce/drizzle-runtime-sqlite
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

export const nodeSqliteConfig: DialectConfig = {
  name: "node-sqlite",
  displayName: "Node SQLite",
  testDir: ".test-patch-node-sqlite",

  // No runtime dependencies - code is extracted from JSR at patch time
  dependencies: {},

  schemaTs,
  configTs,
  pushConfigTs,
  pullConfigTs,
  verifyDbPath: "scripts/node-sqlite/verify-db.ts",

  // No setupPullDbTs - node-sqlite uses push as prerequisite for pull

  dirs: ["drizzle", "drizzle-pull"],

  permissions: {
    help: ["--allow-read=.,./node_modules"],
    generate: ["--allow-read=.,./node_modules", "--allow-write=./drizzle"],
    migrate: [
      "--allow-env",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal,./data.db-wal,./drizzle",
    ],
    verifyMigrate: [
      "--allow-env",
      "--allow-read=.,./node_modules",
      "--allow-write=./data.db,./data.db-journal,./data.db-wal",
    ],
    push: [
      "--allow-env",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal,./data-push.db-wal,./drizzle",
    ],
    verifyPush: [
      "--allow-env",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal,./data-push.db-wal",
    ],
    pull: [
      "--allow-env",
      "--allow-read=.,./node_modules",
      "--allow-write=./data-push.db,./data-push.db-journal,./data-push.db-wal,./drizzle-pull",
    ],
  },

  // Use node:sqlite via the SQLITE_NODE env var
  env: { SQLITE_NODE: "1" },

  verifyArgs: {
    migrate: ["--db", "./data.db"],
    push: ["--db", "./data-push.db", "--skip-migrations"],
  },

  verifyPullSchema,
};
