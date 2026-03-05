/**
 * Shared types for drizzle-kit patch test suite.
 */

// Available command tests
export const AVAILABLE_TESTS = [
  "help",
  "generate",
  "migrate",
  "push",
  "pull",
] as const;
export type TestName = (typeof AVAILABLE_TESTS)[number];

// Supported drizzle-kit versions
export const SUPPORTED_VERSIONS = ["0.30.6", "0.31.8", "0.31.9"];

export interface StepResult {
  name: string;
  success: boolean;
  error?: string;
  output?: string;
}

export interface TestResult {
  version: string;
  steps: StepResult[];
  duration: number;
  success: boolean;
}

export interface TestContext {
  generatedMigrations: boolean;
  migratedDb: boolean;
  pushedDb: boolean;
}

export interface IndependentTestResult {
  steps: StepResult[];
  success: boolean;
}

/**
 * Dialect-specific configuration for test runner.
 */
export interface DialectConfig {
  /** Unique identifier for the dialect */
  name: "pgsql" | "libsql" | "node-sqlite";

  /** Human-readable name for display */
  displayName: string;

  /** Test directory name (e.g., ".test-patch" or ".test-patch-sqlite") */
  testDir: string;

  /** Dependencies to add to deno.jsonc (key: import specifier) */
  dependencies: Record<string, string>;

  /** Schema file content (TypeScript) */
  schemaTs: string;

  /** Main drizzle config file content */
  configTs: string;

  /** Push config file content (uses separate DB) */
  pushConfigTs: string;

  /** Pull config file content (separate DB + output dir) */
  pullConfigTs: string;

  /** Path to verification script (relative to project root) */
  verifyDbPath: string;

  /** Script content for creating pull DB via raw SQL (optional, pgsql only) */
  setupPullDbTs?: string;

  /** Directories to create in test environment */
  dirs: string[];

  /**
   * Permissions for each command.
   * Each command has an array of Deno permission flags.
   */
  permissions: {
    help: string[];
    generate: string[];
    migrate: string[];
    verifyMigrate: string[];
    push: string[];
    verifyPush: string[];
    pull: string[];
    setupPullDb?: string[];
  };

  /**
   * Environment variables to set for commands that need them.
   */
  env?: Record<string, string>;

  /**
   * Patch marker to verify after patching (optional).
   * If specified, runner will check bin.cjs contains this string.
   */
  patchMarker?: string;

  /**
   * Critical patch patterns to verify (optional, pgsql only).
   * Each pattern must be present in bin.cjs for test to pass.
   */
  criticalPatches?: Array<{ name: string; pattern: string }>;

  /**
   * Optional patch patterns to check (non-critical).
   */
  optionalPatches?: Array<{ name: string; pattern: string }>;

  /**
   * Arguments for verify-db.ts per command.
   */
  verifyArgs: {
    migrate: string[];
    push: string[];
  };

  /**
   * Pull verification: check generated schema files.
   * Returns true if the pulled schema matches expectations.
   */
  verifyPullSchema: (content: string) => { success: boolean; error?: string };
}
