const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

function databaseSsl() {
  const mode = process.env.PGSSLMODE?.toLowerCase();
  if (!mode) {
    return undefined;
  }
  if (mode === "disable" || mode === "allow" || mode === "prefer") {
    return false;
  }
  if (mode === "require" || mode === "no-verify") {
    return { rejectUnauthorized: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  throw new Error("Unsupported PGSSLMODE");
}

export function targetDatabaseName() {
  const name = process.env.DETECTIVE_DB_NAME ?? "detective_archives";
  if (!databaseNamePattern.test(name)) {
    throw new Error("DETECTIVE_DB_NAME must use lowercase letters, numbers and underscores");
  }
  return name;
}

export function postgresConfig(database) {
  if (!databaseNamePattern.test(database)) {
    throw new Error("Invalid PostgreSQL database name");
  }

  const ssl = databaseSsl();
  if (process.env.DATABASE_URL) {
    const connectionUrl = new URL(process.env.DATABASE_URL);
    connectionUrl.pathname = `/${database}`;
    return {
      connectionString: connectionUrl.toString(),
      application_name: "detective-archives-maintenance",
      ...(ssl === undefined ? {} : { ssl })
    };
  }

  const requiredKeys = ["PGHOST", "PGUSER", "PGPASSWORD"];
  const missingKeys = requiredKeys.filter((key) => !process.env[key]);
  if (missingKeys.length > 0) {
    throw new Error(`Missing PostgreSQL configuration: ${missingKeys.join(", ")}`);
  }

  const port = Number.parseInt(process.env.PGPORT ?? "5432", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PGPORT must be a valid TCP port");
  }

  return {
    host: process.env.PGHOST,
    port,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database,
    application_name: "detective-archives-maintenance",
    ...(ssl === undefined ? {} : { ssl })
  };
}

export function maintenanceDatabaseName() {
  const name = process.env.PGMAINTENANCE_DATABASE ?? process.env.PGDATABASE ?? "postgres";
  if (!databaseNamePattern.test(name)) {
    throw new Error("Invalid PostgreSQL maintenance database name");
  }
  return name;
}
