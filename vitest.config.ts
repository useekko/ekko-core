import { defineConfig } from 'vitest/config';

// Only the extension's tests. The directory server (server/) has its own node:test runner.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
