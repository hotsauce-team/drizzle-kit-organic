# Native node:sqlite Support for drizzle-kit

This directory contains the implementation and tests for using `node:sqlite`
with drizzle-kit.

## Overview

The patch in this repo adds native `node:sqlite` support to drizzle-kit. When
`SQLITE_NODE=1` is set, drizzle-kit uses `node:sqlite` (available in Deno 2.x
and Node.js 22+) instead of `@libsql/client` or `better-sqlite3`.

**No additional packages required** - the patch injects the node:sqlite driver
code directly into drizzle-kit.

## How It Works

The patch modifies drizzle-kit's `connectToSQLite` function to check for
`SQLITE_NODE` env var before falling back to `@libsql/client` or
`better-sqlite3`:

```javascript
// Injected by patch
if (process.env.SQLITE_NODE) {
  const { DatabaseSync } = await import("node:sqlite");
  // ... node:sqlite implementation using same pattern as better-sqlite3
  return {
    ...db,
    packageName: "node:sqlite",
    proxy,
    transactionProxy,
    migrate: migrateFn,
  };
}

// Original code follows
if (await checkPackage("@libsql/client")) {
  // ...
}
```

The implementation follows the same pattern as drizzle-kit's existing
`better-sqlite3` support, using `drizzle-orm/sqlite-proxy` for the migration
helper.

## Files

- [dialect.ts](dialect.ts) - Test configuration for node-sqlite dialect
- [test-patch.ts](test-patch.ts) - Test runner entry point
- [verify-db.ts](verify-db.ts) - Database verification script

## Usage

After patching drizzle-kit:

```bash
# Run migrations with node:sqlite
SQLITE_NODE=1 deno run \
  --allow-env --allow-read --allow-write \
  ./node_modules/drizzle-kit/bin.cjs migrate

# Push schema directly
SQLITE_NODE=1 deno run \
  --allow-env --allow-read --allow-write \
  ./node_modules/drizzle-kit/bin.cjs push

# Pull (introspect) existing database
SQLITE_NODE=1 deno run \
  --allow-env --allow-read --allow-write \
  ./node_modules/drizzle-kit/bin.cjs pull
```

## Runtime Requirements

- **Deno 2.6+** for `node:sqlite` support (2.7+ recommended for full
  `setReturnArrays` support)
- **Node.js 22+** for `node:sqlite` support

## Running Tests

```bash
# From the repo root
deno task test:node-sqlite

# Test a specific version
deno task test:node-sqlite 0.31.9

# Quick test (patch only)
deno task test:node-sqlite --quick
```

## Relationship to @hotsauce/drizzle-runtime-sqlite

This patch is independent of `@hotsauce/drizzle-runtime-sqlite`.

- **drizzle-kit** (migrations) - Uses this patch for native node:sqlite support
- **drizzle-orm** (queries) - Use `@hotsauce/drizzle-runtime-sqlite` for the
  query builder

You can use both together:

```typescript
// drizzle-orm queries - use @hotsauce/drizzle-runtime-sqlite
import { drizzle } from "@hotsauce/drizzle-runtime-sqlite";
const db = drizzle("./data.db", { schema });

// drizzle-kit migrations - use SQLITE_NODE=1 env var
// SQLITE_NODE=1 deno run ... drizzle-kit migrate
```

## Technical Details

The node:sqlite implementation:

1. Uses `DatabaseSync` from `node:sqlite`
2. Wraps queries via `drizzle-orm/sqlite-proxy` for the migrate helper
3. Converts object rows to array rows when needed (sqlite-proxy requirement)
4. Handles transactions via `BEGIN`/`COMMIT`/`ROLLBACK`
5. Reports `packageName: "node:sqlite"` in return value
