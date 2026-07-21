import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { postgresConfig, targetDatabaseName } from "./lib/postgres-config.mjs";

const { Client } = pg;
const schemaPath = path.resolve("database/schema.sql");
const migrationDirectory = path.resolve("database/migrations");

const incrementalFiles = (await readdir(migrationDirectory))
  .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
  .sort();
const migrations = [
  { version: "001_initial_schema", filePath: schemaPath },
  ...incrementalFiles.map((file) => ({
    version: path.basename(file, ".sql"),
    filePath: path.join(migrationDirectory, file)
  }))
];

if (new Set(migrations.map((migration) => migration.version)).size !== migrations.length) {
  throw new Error("Duplicate database migration version");
}

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

  for (const migration of migrations) {
    const sql = await readFile(migration.filePath, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query(
      "SELECT checksum FROM schema_migrations WHERE version = $1",
      [migration.version]
    );
    if (applied.rowCount === 1) {
      if (applied.rows[0].checksum !== checksum) {
        throw new Error(`${migration.version} was modified after it was applied`);
      }
      console.log(`Migration ${migration.version}: already applied`);
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, checksum]
      );
      await client.query("COMMIT");
      console.log(`Migration ${migration.version}: applied`);
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
