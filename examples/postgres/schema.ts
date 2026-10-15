// Drizzle schema, matching migrations/0001_todos.sql. With drizzle-kit you can generate the SQL
// from this file instead (see docs/postgres.md); migratePostgres() applies either.
import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull().unique(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { todos };
