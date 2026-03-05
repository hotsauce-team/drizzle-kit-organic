# Peer Review (git diff)

Reviewed the current working-tree diff (`git diff`) and the new, untracked `scripts/node-sqlite/*` files.

## Summary

This change set adds native `node:sqlite` support to the patched drizzle-kit path, gated by `SQLITE_NODE=1`, plus a new test dialect (`node-sqlite`) and docs updates.

Directionally this is great (it avoids `--allow-ffi` for local SQLite), but there are a few correctness and packaging/UX risks worth addressing before merging.

## Files covered

Modified:

- [README.md](README.md)
- [deno.jsonc](deno.jsonc)
- [deno.lock](deno.lock)
- [scripts/patch-drizzle-kit.ts](scripts/patch-drizzle-kit.ts)
- [scripts/pgsql/dialect.ts](scripts/pgsql/dialect.ts)
- [scripts/shared/test-runner.ts](scripts/shared/test-runner.ts)
- [scripts/shared/types.ts](scripts/shared/types.ts)

New:

- [scripts/node-sqlite/README.md](scripts/node-sqlite/README.md)
- [scripts/node-sqlite/dialect.ts](scripts/node-sqlite/dialect.ts)
- [scripts/node-sqlite/test-patch.ts](scripts/node-sqlite/test-patch.ts)
- [scripts/node-sqlite/verify-db.ts](scripts/node-sqlite/verify-db.ts)

## Review notes (most important first)

### 1) Top-level side effect + implicit network requirement (likely a blocker)

In [scripts/patch-drizzle-kit.ts](scripts/patch-drizzle-kit.ts) this runs at module load time:

```ts
await import("jsr:@hotsauce/drizzle-runtime-sqlite@0.1.2/kit-string")
```

Why this matters:

- [mod.ts](mod.ts) re-exports `patchDrizzleKit` from the patch script, so importing the package (even just to read `SUPPORTED_VERSIONS`) triggers the JSR import.
- That can cause network fetches / dependency resolution and changes the permission profile of the patcher. Previously, patching could plausibly be `--allow-read/--allow-write` only; now it may need network at least once unless cached.

Suggested fixes:

- Make this import lazy inside `patchDrizzleKit()` (and ideally only when applying the node-sqlite patch), or inline/vendor the driver block as a string.
- If the import is intentional, document it explicitly in [README.md](README.md) (permissions + offline behavior).

### 2) Patch version messaging is inconsistent

`PATCH_MARKER` is `V14`, but the log strings in `patchDrizzleKit()` still say v12 (“already patched (v12)”, “re-patch to v12”). This is confusing and makes debugging harder.

### 3) Injection targeting + multiplicity risk

The injection patch is global:

```ts
/if \(await checkPackage\("@libsql\/client"\)\) \{/g
```

If drizzle-kit’s bundle contains that check more than once, it will inject multiple copies of the `SQLITE_NODE` block and could break parsing or behavior.

Suggestion: anchor the patch to the `connectToSQLite` function body (or enforce “exactly one match” and fail/warn otherwise).

### 4) Driver block assumptions

The injected block calls:

```js
const dbPath = normaliseSQLiteUrl(credentials2.url, "better-sqlite");
return await createNodeSqlDriver(dbPath, prepareSqliteParams);
```

Things to validate across all supported drizzle-kit versions:

- `credentials2` is always the correct variable name in scope at the injection point.
- `normaliseSQLiteUrl` exists and accepts the `"better-sqlite"` tag as intended.
- `createNodeSqlDriver` and `prepareSqliteParams` are guaranteed to exist where injected.

If any of these drift between drizzle-kit versions, this will become a flaky/fragile patch.

### 5) Docs vs implementation: “independent of @hotsauce/drizzle-runtime-sqlite”

[scripts/node-sqlite/README.md](scripts/node-sqlite/README.md) says the patch is independent of `@hotsauce/drizzle-runtime-sqlite`, but the patch script imports it to source the driver block.

Either adjust the docs, or change the implementation so it truly doesn’t depend on that package.

### 6) Test runner help text will be wrong for node-sqlite

In [scripts/shared/test-runner.ts](scripts/shared/test-runner.ts) the `--help` output hardcodes task names using:

```ts
config.name === "pgsql" ? "pglite" : "libsql"
```

For `node-sqlite`, it will print `test:libsql` examples.

### 7) Formatting / hygiene

- A trailing whitespace-only line was introduced in [scripts/shared/test-runner.ts](scripts/shared/test-runner.ts) after writing the patch script.
- There are a couple of trailing spaces in the new `node:sqlite` section in [README.md](README.md).

Recommendation: run `deno fmt` before merging.

### 8) `deno.lock` growth / unexpected entries

`deno.lock` now includes entries like `npm:create-vite@latest`. That looks unrelated to the patcher/test harness; if it’s accidental, it’ll be noise and increase churn.

Suggestion: confirm lockfile changes are expected from a clean cache; otherwise regenerate.

## CI / coverage suggestions

- [.github/workflows/test-patch.yml](.github/workflows/test-patch.yml) doesn’t include `scripts/node-sqlite/**` in its path filters, so node-sqlite changes won’t automatically trigger tests.
- Consider adding a node-sqlite job once the driver block is stable.

## Smoke tests to run locally

- `deno task test:pglite:quick`
- `deno task test:libsql --quick`
- `deno task test:node-sqlite --quick` (and ideally one full run on `0.31.9`)

## Overall

The feature is valuable and the test dialect addition is a good pattern fit. Before merging, I’d prioritize fixing the top-level JSR import side effect and the V12/V14 messaging, since those are most likely to surprise users and break the “minimal permissions” story.
