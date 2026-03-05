#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * PostgreSQL (PGlite) test suite entry point.
 *
 * Usage:
 *   deno task test:pglite                    # Test all supported versions
 *   deno task test:pglite 0.30.6             # Test a specific version
 *   deno task test:pglite --quick            # Quick test (patch only)
 *   deno task test:pglite --test=push        # Run specific tests
 */

import { runTests } from "../shared/test-runner.ts";
import { pgsqlConfig } from "./dialect.ts";

await runTests(pgsqlConfig);
