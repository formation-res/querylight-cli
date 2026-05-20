import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
