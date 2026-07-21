import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const migrationVersion = "001_initial_schema";
const schemaPath = path.resolve("database/schema.sql");
const schemaSql = await readFile(schemaPath, "utf8");
const checksum = createHash("sha256").update(schemaSql).digest("hex");
const client = new Client(postgresConfig(targetDatabaseName()));
let migrationLockHeld = false;

try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["detective_archives_migrations"]);
  migrationLockHeld = true;
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await client.query(
    "SELECT checksum FROM schema_migrations WHERE version = $1",
    [migrationVersion]
  );
  if (applied.rowCount === 1) {
    if (applied.rows[0].checksum !== checksum) {
      throw new Error(`${migrationVersion} was modified after it was applied`);
    }
    console.log(`Migration ${migrationVersion}: already applied`);
  } else {
    await client.query("BEGIN");
    try {
      await client.query(schemaSql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migrationVersion, checksum]
      );
      await client.query("COMMIT");
      console.log(`Migration ${migrationVersion}: applied`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  if (migrationLockHeld) {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["detective_archives_migrations"]);
  }
  await client.end();
}
