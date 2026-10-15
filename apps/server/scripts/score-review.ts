/**
 * Scores a human-reviewed benchmark CSV (from eval-quality.ts): reviewers put 1 in wrong_key,
 * ambiguous and/or unsupported_evidence. Prints rates per material and overall.
 * Usage: tsx scripts/score-review.ts docs/evidence/quality/etalon-ai.csv
 */
import { readFileSync } from "node:fs";
import Papa from "papaparse";

const file = process.argv[2]!;
const parsed = Papa.parse<Record<string, string>>(readFileSync(file, "utf8").replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
const rows = parsed.data;
const reviewed = rows.filter((r) => ["wrong_key", "ambiguous", "unsupported_evidence"].some((k) => (r[k] ?? "").trim() !== ""));
const groups = new Map<string, Record<string, string>[]>();
for (const r of reviewed) groups.set(`${r.material}/${r.method}`, [...(groups.get(`${r.material}/${r.method}`) ?? []), r]);
const rate = (list: Record<string, string>[], k: string) => (list.length ? Math.round((list.filter((r) => r[k]?.trim() === "1").length / list.length) * 1000) / 10 : null);
const out = [...groups.entries()].map(([g, list]) => ({ group: g, reviewed: list.length, wrongKeyPct: rate(list, "wrong_key"), ambiguousPct: rate(list, "ambiguous"), unsupportedEvidencePct: rate(list, "unsupported_evidence") }));
console.log(JSON.stringify({ file, total: rows.length, reviewed: reviewed.length, groups: out, overall: { wrongKeyPct: rate(reviewed, "wrong_key"), ambiguousPct: rate(reviewed, "ambiguous"), unsupportedEvidencePct: rate(reviewed, "unsupported_evidence") } }, null, 2));
if (reviewed.length < rows.length) console.error(`${rows.length - reviewed.length} rows are not reviewed yet`);
