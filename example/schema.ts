/**
 * Example database schema for drizzle-kit demo.
 * 
 * This is a minimal example showing how to define tables with Drizzle ORM.
 * drizzle-kit will read this file and generate SQL migrations.
 */

import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// This is just a test to make sure we can import from a jsr package in this file.
import { assertEquals } from "@std/assert"
assertEquals("", "");

/**
 * Users table
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 140 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Posts table
 */
export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content"),
  authorId: serial("author_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
