export interface DatabaseClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export interface DatabaseQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export async function queryRows<Row>(
  database: DatabaseClient,
  sql: string,
  values: unknown[] = []
) {
  return database.query(sql, values) as Promise<DatabaseQueryResult<Row>>;
}
