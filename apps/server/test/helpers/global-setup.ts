import postgres from "postgres";
import { migrate } from "../../src/db/migrate";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
export const TEMPLATE_DB = "talaba_test_template";

export default async function setup() {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEMPLATE_DB} with (force)`);
  await admin.unsafe(`create database ${TEMPLATE_DB}`);
  await admin.end();
  const tpl = postgres(ADMIN_URL.replace(/\/[^/]+$/, `/${TEMPLATE_DB}`), { max: 1, onnotice: () => {} });
  await migrate(tpl as never);
  await tpl.end();
}
