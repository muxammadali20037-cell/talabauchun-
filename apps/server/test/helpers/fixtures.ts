import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => readFileSync(path.join(here, "../fixtures/generated", name));
export const sourceFixture = (name: string) => readFileSync(path.join(here, "../fixtures/source", name));
