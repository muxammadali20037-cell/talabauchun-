import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(here, "migrations");

/** Applies pending *.sql migrations in lexical order, each in its own transaction, under an advisory lock. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied: string[] = [];
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7262005)`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(path.join(dir, file), "utf8");
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
