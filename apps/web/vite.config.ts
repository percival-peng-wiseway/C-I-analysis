import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        headers: {
          Authorization: `Bearer ${process.env.DURABLE_API_BEARER_TOKEN ?? "ci-local-development-only"}`,
        },
      },
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    include: ["src/features/ci/**/*.test.{ts,tsx}", "src/router.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
} as Parameters<typeof defineConfig>[0]);
