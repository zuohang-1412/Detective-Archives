export interface DatabaseClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  connect?(): Promise<DatabaseConnection>;
  end(): Promise<void>;
}

export interface DatabaseConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

export interface DatabaseQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export async function queryRows<Row>(
  database: Pick<DatabaseClient, "query"> | DatabaseConnection,
  sql: string,
  values: unknown[] = []
) {
  return database.query(sql, values) as Promise<DatabaseQueryResult<Row>>;
}
