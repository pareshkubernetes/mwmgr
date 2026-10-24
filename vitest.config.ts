import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/infra/ports.ts', 'src/domain/**'],
      reporter: ['text-summary', 'html', 'lcov'],
      thresholds: { lines: 85, branches: 75, functions: 85, statements: 85 },
    },
  },
});
