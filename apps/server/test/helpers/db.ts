import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type Sql } from "../../src/db/index";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

/** Creates an isolated database cloned from the migrated template. */
export async function createTestDb(): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  const name = `talaba_t_${randomBytes(5).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name} template talaba_test_template`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const sql = createDb(url, 10);
  return {
    sql,
    url,
    drop: async () => {
      await sql.end({ timeout: 2 });
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
