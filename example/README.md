# Drizzle-Kit + Deno Example

This example demonstrates how to use **drizzle-kit** with **Deno** using the `@hotsauce-team/drizzle-kit-deno-patch` patch.

## Setup

### 1. Install dependencies

```bash
deno install
```

### 2. Patch drizzle-kit

```bash
deno task patch
```

### 3. Generate migrations

```bash
deno task db:generate
```

### 4. Apply migrations

```bash
deno task db:migrate
```

## Files

- `deno.jsonc` - Deno configuration with tasks and permissions
- `drizzle.config.ts` - Drizzle configuration (uses PGlite for local dev)
- `schema.ts` - Example database schema

## How it works

The `deno task patch` command runs the `@hotsauce-team/drizzle-kit-deno-patch` package, which patches drizzle-kit's bundled `bin.cjs` file for Deno compatibility.

After patching, you can run drizzle-kit commands using the permission set defined in `deno.jsonc`:

```bash
deno run --permission-set=drizzle-kit ./node_modules/drizzle-kit/bin.cjs generate
```

The tasks in `deno.jsonc` wrap these commands for convenience.
