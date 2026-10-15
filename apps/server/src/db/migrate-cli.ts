import { loadConfig } from "../config";
import { createDb } from "./index";
import { migrate } from "./migrate";

const cfg = loadConfig();
const sql = createDb(cfg.DATABASE_URL, 1);
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await sql.end();
}
