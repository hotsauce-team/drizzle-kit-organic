import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Path to your schema file(s)
  schema: "./schema.ts",
  
  // Output directory for migrations
  out: "./drizzle",
  
  // Database dialect
  dialect: "postgresql",
  
  // Use PGlite driver for local development (no DATABASE_URL)
  // Use default PostgreSQL driver for production (with DATABASE_URL)
  ...(Deno.env.get("DATABASE_URL") ? {} : { driver: "pglite" as const }),
  
  // Database connection
  dbCredentials: {
    // Production: Use DATABASE_URL environment variable (e.g., Neon, Supabase)
    // Development: Use local PGlite with file-based storage
    url: Deno.env.get("DATABASE_URL") || "file:./data",
  },
});
