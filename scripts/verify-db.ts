#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net

import { PGlite } from "@electric-sql/pglite";

function usage(): never {
  console.error(
    "Usage: deno run -A scripts/verify-db.ts [--db ./data] [--table public.users] [--columns id,name]",
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

function getField(row: unknown, index: number, key: string): unknown {
  if (Array.isArray(row)) return row[index];
  if (row && typeof row === "object" && key in row) {
    // deno-lint-ignore no-explicit-any
    return (row as any)[key];
  }
  return undefined;
}

const args = [...Deno.args];
if (args.includes("--help") || args.includes("-h")) usage();

const dbPath = getArgValue("--db", args) ?? "./data";
const table = getArgValue("--table", args) ?? "public.users";
const columnsCsv = getArgValue("--columns", args) ?? "id,name";
const expectedColumns = columnsCsv
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const [expectedSchema, expectedTable] = table.includes(".")
  ? (table.split(".", 2) as [string, string])
  : (["public", table] as [string, string]);

const db = new PGlite(dbPath);

// Table existence via information_schema
const tablesRes = await db.query(
  "select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' order by table_schema, table_name",
);
const tables = (tablesRes?.rows ?? []).map((row: unknown) => {
  const schema = getField(row, 0, "table_schema");
  const name = getField(row, 1, "table_name");
  return String(schema) + "." + String(name);
});

if (!tables.includes(`${expectedSchema}.${expectedTable}`)) {
  await db.close();
  fail(
    "❌ Expected table " + `${expectedSchema}.${expectedTable}` +
      " to exist after migrate; found: " +
      (tables.length ? tables.join(", ") : "<none>"),
  );
}

// Column existence
const colsRes = await db.query(
  "select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
  [expectedSchema, expectedTable],
);
const cols = (colsRes?.rows ?? []).map((row: unknown) =>
  String(getField(row, 0, "column_name"))
);

for (const expected of expectedColumns) {
  if (!cols.includes(expected)) {
    await db.close();
    fail(
      "❌ Expected column '" + expected + "' in " +
        `${expectedSchema}.${expectedTable}` + "; found: " +
        (cols.length ? cols.join(", ") : "<none>"),
    );
  }
}

console.log(
  `✅ Verified DB schema: ${expectedSchema}.${expectedTable}(${expectedColumns.join(", ")})`,
);

// Verify migrations were recorded as applied.
// drizzle-kit typically uses a table named __drizzle_migrations (schema may vary).
const migTableRes = await db.query(
  "select table_schema, table_name from information_schema.tables where table_type = 'BASE TABLE' and table_name = '__drizzle_migrations'",
);
const migRows = migTableRes?.rows ?? [];
if (migRows.length === 0) {
  await db.close();
  fail("❌ Expected __drizzle_migrations table to exist after migrate");
}

// Pick the first schema that contains the migrations table.
const migSchema = String(getField(migRows[0], 0, "table_schema") ?? "public");
const migName = String(getField(migRows[0], 1, "table_name") ?? "__drizzle_migrations");

// Count applied migrations.
const countSql = `select count(*)::int as n from "${migSchema}"."${migName}"`;
const countRes = await db.query(countSql);
const n = Number(getField(countRes?.rows?.[0], 0, "n"));
if (!Number.isFinite(n) || n <= 0) {
  await db.close();
  fail(
    "❌ Expected at least 1 applied migration row in " +
      `${migSchema}.${migName}` + "; got: " + String(n),
  );
}

console.log(`✅ Verified migrations journal: ${migSchema}.${migName} rows=${n}`);
await db.close();
