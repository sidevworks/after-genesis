import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/out/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
