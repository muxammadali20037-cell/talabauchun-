import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

export function createDb(url: string, max = 20): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    // keep Telegram ids exact: bigint columns come back as strings unless converted explicitly
    types: {},
    onnotice: () => {},
    transform: { undefined: null },
  });
}
