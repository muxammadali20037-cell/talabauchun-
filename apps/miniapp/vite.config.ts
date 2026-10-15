import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the API server under /app/ (same origin: no CORS, cookies not needed).
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true, target: "es2022" },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/files": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
