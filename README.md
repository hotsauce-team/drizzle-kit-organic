# Drizzle-Kit + Deno Demo

This folder demonstrates how to use **drizzle-kit** with **Deno** by patching
the drizzle-kit binary for Deno compatibility.

## The Problem

Drizzle-kit is designed for Node.js and has several incompatibilities with Deno:

1. **`require()` calls** - Deno doesn't support CommonJS `require()` for TypeScript files
2. **esbuild dependency** - Uses esbuild for TypeScript transpilation (Deno has native TS support)
3. **Directory traversal** - Walks parent directories looking for tsconfig.json (permission issues)
4. **Eager environment checks** - Several libraries check env vars at load time (dotenv, chalk, etc.)
5. **Blocking event loop** - Commands don't exit cleanly after completion

## The Solution

A patch script that modifies drizzle-kit's bundled `bin.cjs` file to:

1. Disable `walkForTsConfig` and `recursivelyResolveSync` (prevents permission issues)
2. Disable `safeRegister` (removes esbuild dependency)
3. Replace `require()` with `import()` for loading TS config and schema files
4. Stub color support functions to avoid env var checks at load time
5. Defer `os.homedir()` and `os.tmpdir()` calls to avoid permission prompts
6. Add `process.exit(0)` after commands complete (prevents hanging)

## Features

- **JSR packages in schema** - Your schema files can import from JSR (`@std/*`, etc.) since Deno handles the imports natively

## Files

- `deno.jsonc` - Deno configuration with tasks and permission sets
- `drizzle.config.ts` - Drizzle configuration file
- `schema.ts` - Example database schema (demonstrates JSR imports)
- `scripts/patch-drizzle-kit.ts` - The patch script

## Setup

### 1. Install dependencies

```bash
deno install
```

This downloads drizzle-kit and drizzle-orm to `node_modules/`.

### 2. Patch drizzle-kit

```bash
deno task build
```

This runs the patch script which modifies `node_modules/.deno/drizzle-kit@X.X.X/node_modules/drizzle-kit/bin.cjs`.

### 3. Generate migrations

```bash
deno task db:generate
```

### 4. Apply migrations

```bash
deno task db:migrate
```

## How It Works

### Permission Sets

The `deno.jsonc` defines permission sets to limit what drizzle-kit can access:

```jsonc
"permissions": {
  "drizzle-kit": {
    "read": ["./drizzle", "./drizzle.config.ts", "."],
    "write": ["./drizzle", "./data"],
    "env": ["DATABASE_URL", "USER", ...],
    "net": ["db.prisma.io"]  // For introspection features
  }
}
```

This allows fine-grained control over file system access, environment variables, and network access.

### The Patch Script

The patch script:

1. **Finds** the drizzle-kit binary in `node_modules/`
2. **Checks** the version (tested with 0.30.6, 0.31.8)
3. **Applies patches** using regex replacements
4. **Marks** the file as patched to avoid re-patching
5. **Reports** which patches succeeded or failed

Key patches explained:

```typescript
// Disable TypeScript config walking (permission issues)
function walkForTsConfig(directory, readdirSync) {
  return void 0; // PATCHED: disabled for Deno
}

// Disable esbuild-based TypeScript registration
safeRegister = async () => {
  return { unregister: () => {} }; // PATCHED: esbuild disabled for Deno
}

// Use import() instead of require() for TypeScript files
const required = await import(path4); // PATCHED: import for Deno TS support

// Force exit after CLI command completes
run([...]).then(() => { setTimeout(() => process.exit(0), 50); });
```

### Running drizzle-kit

Instead of running `drizzle-kit generate`, you run the binary directly with Deno:

```bash
# Node.js way (doesn't work with Deno)
npx drizzle-kit generate

# Deno way (after patching)
deno run --permission-set=drizzle-kit ./node_modules/drizzle-kit/bin.cjs generate
```

The `--permission-set=drizzle-kit` flag uses the permissions defined in `deno.jsonc`.

## Supported drizzle-kit versions

- 0.30.6
- 0.31.8 (recommended)

The patch script will warn but attempt to patch other versions.

## Testing

A comprehensive test suite verifies the patch works across all supported drizzle-kit versions.

### Testing Strategy

The test suite performs the following checks for each version:

1. **Setup** - Creates an isolated test environment with a minimal Deno project
2. **Install** - Installs the specific drizzle-kit version via `deno install`
3. **Patch** - Applies the patch script and verifies it completes successfully
4. **Verify Marker** - Checks that the patch marker is present in `bin.cjs`
5. **Verify All Patches** - Confirms each individual patch was applied:
   - Critical patches (must succeed): `walkForTsConfig`, `safeRegister`, `config loading`, `CLI exit handler`
   - Optional patches (may vary by version): color stubs, dotenv stubs, homedir/tmpdir deferrals
6. **Runtime Tests** (full mode only):
   - `drizzle-kit --help` - Verifies basic CLI functionality
   - `drizzle-kit generate` - Verifies config and schema loading works

### Run all tests locally

```bash
deno task test:patch
```

### Test a specific version

```bash
deno task test:patch 0.31.8
```

### Quick test (patch only, no runtime tests)

```bash
deno task test:patch --quick
```

### Test options

```
Options:
  --quick, -q    Quick test (only verify patch applies, skip runtime tests)
  --keep, -k     Keep test directories after completion
  --help, -h     Show this help message
```

### CI

Tests run automatically via GitHub Actions:

- **On push to `main`** - Full tests for all supported versions (when patch files change)
- **On pull requests** - Full tests in parallel matrix + quick smoke test
- **Manual trigger** - Can be run manually via workflow dispatch

Each version is tested in parallel using a matrix strategy for faster feedback.

See [.github/workflows/test-patch.yml](.github/workflows/test-patch.yml) for the CI configuration.

## Troubleshooting

### "Pattern not found" errors

The patch script uses regex patterns to find code to patch. If drizzle-kit's code changes significantly, patterns may not match. Check:

1. Is the drizzle-kit version supported?
2. Has the bundled code structure changed?

### Permission denied errors

Make sure your permission set includes all required paths and env vars. Use `DENO_TRACE_PERMISSIONS=1` to see which permissions are being requested:

```bash
DENO_TRACE_PERMISSIONS=1 deno run --permission-set=drizzle-kit ./node_modules/drizzle-kit/bin.cjs generate
```

### Command hangs after completion

The "CLI exit handler" patch adds `process.exit(0)` after commands complete. If this patch fails, drizzle-kit may hang. Check the patch results for failures.

## Why This Approach?

Deno has excellent Node.js compatibility, but drizzle-kit's architecture poses challenges:

1. **Bundled code** - drizzle-kit ships a single bundled `bin.cjs` file
2. **Load-time side effects** - Many operations happen at import time, before any CLI logic runs
3. **CommonJS assumptions** - Uses `require()` for dynamic imports of user config files

Patching the binary directly is the most reliable solution until drizzle-kit adds official Deno support.
