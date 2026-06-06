import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/drizzle",
  dbCredentials: {
    url: process.env.MAIN_DB_PATH || "./data/main.sqlite",
  },
});
