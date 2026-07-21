import pg from "pg";
import {
  maintenanceDatabaseName,
  postgresConfig,
  targetDatabaseName
} from "./lib/postgres-config.mjs";

const { Client } = pg;
const target = targetDatabaseName();
const client = new Client(postgresConfig(maintenanceDatabaseName()));

try {
  await client.connect();
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [target]);
  if (existing.rowCount === 1) {
    console.log(`Database ${target}: already exists`);
  } else {
    await client.query(`CREATE DATABASE "${target}"`);
    console.log(`Database ${target}: created`);
  }
} finally {
  await client.end();
}
