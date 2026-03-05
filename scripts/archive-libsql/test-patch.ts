#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * SQLite/LibSQL test suite entry point.
 *
 * Usage:
 *   deno task test:libsql                    # Test all supported versions
 *   deno task test:libsql 0.30.6             # Test a specific version
 *   deno task test:libsql --quick            # Quick test (patch only)
 *   deno task test:libsql --test=push        # Run specific tests
 */

import { runTests } from "../shared/test-runner.ts";
import { libsqlConfig } from "./dialect.ts";

await runTests(libsqlConfig);
