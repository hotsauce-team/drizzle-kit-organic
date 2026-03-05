#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi

/**
 * Verify SQLite/LibSQL database schema matches expected structure.
 */

import { createClient } from "@libsql/client/node";

function usage(): never {
  console.error(
    "Usage: deno run --allow-read --allow-write --allow-ffi scripts/verify-db-sqlite.ts [--db ./data.db] [--table users] [--columns id,name] [--skip-migrations]",
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

// Create libsql client for local file
const client = createClient({
  url: `file:${dbPath}`,
});

// Table existence via sqlite_master
const tablesRes = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const tables = tablesRes.rows.map((row) => String(row.name));

if (!tables.includes(table)) {
  client.close();
  fail(
    "❌ Expected table " +
      table +
      " to exist; found: " +
      (tables.length ? tables.join(", ") : "<none>"),
  );
}

// Column existence via PRAGMA table_info
const colsRes = await client.execute(`PRAGMA table_info(${table})`);
const cols = colsRes.rows.map((row) => String(row.name));

for (const expected of expectedColumns) {
  if (!cols.includes(expected)) {
    client.close();
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
    client.close();
    fail(
      "❌ Expected __drizzle_migrations table to exist (use --skip-migrations to skip this check)",
    );
  }

  const migrationsRes = await client.execute(
    "SELECT COUNT(*) as count FROM __drizzle_migrations",
  );
  const migrationCount = Number(migrationsRes.rows[0]?.count ?? 0);
  if (migrationCount === 0) {
    client.close();
    fail("❌ Expected at least one migration in __drizzle_migrations");
  }
  console.log(`✅ Found ${migrationCount} migration(s)`);
}

client.close();
console.log(`✅ Verified DB schema: table=${table}, columns=${cols.join(",")}`);
Deno.exit(0);
