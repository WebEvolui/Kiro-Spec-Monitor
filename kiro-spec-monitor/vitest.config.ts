import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure TypeScript modules under src/ (excluding vscode-dependent glue)
    // and their co-located / tests/ specs are exercised here.
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
