// Production build: bundles the TypeScript entry points (and the workspace package @talaba/shared)
// into dist/*.js; npm dependencies stay external and are installed with `pnpm install --prod`.
import { build } from "esbuild";
import { cp, readFile, rm } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@talaba/"));

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: {
    main: "src/main.ts",
    "worker-main": "src/worker-main.ts",
    "all-in-one": "src/all-in-one.ts",
    "migrate-cli": "src/db/migrate-cli.ts",
    "telegram-setup": "src/ops/telegram-setup.ts",
    "reapply-deletions": "src/ops/reapply-deletions.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  // migrate.ts resolves ./migrations next to the running file
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
await cp("src/db/migrations", "dist/migrations", { recursive: true });
console.log("built dist/ (entry points: main, worker-main, all-in-one, migrate-cli, telegram-setup, reapply-deletions)");
