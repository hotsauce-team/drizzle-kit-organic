#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

/**
 * Verify SQLite database schema matches expected structure.
 * Uses node:sqlite directly (available in Deno 2.x and Node.js 22+)
 */

// @ts-types="npm:@types/node"
import { DatabaseSync } from "node:sqlite";

function usage(): never {
  console.error(
    "Usage: deno run --allow-read --allow-write scripts/node-sqlite/verify-db.ts [--db ./data.db] [--table users] [--columns id,name] [--skip-migrations]",
  );
  Deno.exit(2);
}

function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

function getArgValue(flag: string, args: string[]): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const args = [...Deno.args];
if (args.includes("--help") || args.includes("-h")) usage();

const dbPath = getArgValue("--db", args) ?? "./data.db";
const table = getArgValue("--table", args) ?? "users";
const columnsCsv = getArgValue("--columns", args) ?? "id,name";
const skipMigrations = args.includes("--skip-migrations");
const expectedColumns = columnsCsv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Open database using node:sqlite
const db = new DatabaseSync(dbPath);

// Table existence via sqlite_master
const tablesStmt = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const tablesRows = tablesStmt.all() as Array<{ name: string }>;
const tables = tablesRows.map((row) => String(row.name));

if (!tables.includes(table)) {
  fail(
    "❌ Expected table " +
      table +
      " to exist; found: " +
      (tables.length ? tables.join(", ") : "<none>"),
  );
}

// Column existence via PRAGMA table_info
const colsStmt = db.prepare(`PRAGMA table_info(${table})`);
const colsRows = colsStmt.all() as Array<{ name: string }>;
const cols = colsRows.map((row) => String(row.name));

for (const expected of expectedColumns) {
  if (!cols.includes(expected)) {
    fail(
      `❌ Expected column "${expected}" in table ${table}; found: ${
        cols.join(", ")
      }`,
    );
  }
}

// Check migrations table if not skipped
if (!skipMigrations) {
  if (!tables.includes("__drizzle_migrations")) {
    fail(
      "❌ Expected __drizzle_migrations table to exist (use --skip-migrations to skip this check)",
    );
  }

  const migrationsStmt = db.prepare(
    "SELECT COUNT(*) as count FROM __drizzle_migrations",
  );
  const migrationsResult = migrationsStmt.get() as
    | { count: number }
    | undefined;
  const migrationCount = Number(migrationsResult?.count ?? 0);
  if (migrationCount === 0) {
    fail("❌ Expected at least one migration in __drizzle_migrations");
  }
  console.log(`✅ Found ${migrationCount} migration(s)`);
}

db.close();
console.log(`✅ Verified DB schema: table=${table}, columns=${cols.join(",")}`);
Deno.exit(0);
