#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Node SQLite test suite entry point.
 *
 * Usage:
 *   deno task test:node-sqlite                    # Test all supported versions
 *   deno task test:node-sqlite 0.30.6             # Test a specific version
 *   deno task test:node-sqlite --quick            # Quick test (patch only)
 *   deno task test:node-sqlite --test=push        # Run specific tests
 */

import { runTests } from "../shared/test-runner.ts";
import { nodeSqliteConfig } from "./dialect.ts";

await runTests(nodeSqliteConfig);
