/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    silent: false, // Keep test names visible
    reporters: ['verbose'],
    pool: 'forks', // Most compatible with Bun runtime
    forks: {
      isolate: true,      // Ensure test isolation
      singleFork: false,  // Allow parallel execution
    },
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.idea/**',
    ],
    testTimeout: 5000, // 5 second timeout for tests
    hookTimeout: 30000, // 30 second timeout for hooks
    teardownTimeout: 10000, // 10 second timeout for teardown
    watch: false,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    // Override console methods to reduce noise from expected errors
    setupFiles: ['./tests/suppress-console.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov', 'clover'],
      reportsDirectory: './coverage',
      // Vitest 4 dropped `coverage.all`; without `include` only files that
      // some test imports are measured.
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/types/**/*.ts',
        '**/__mocks__/**',
        '**/test-utils/**',
        '**/*.config.{js,ts}',
        '**/.eslintrc.{js,cjs}',
      ],
      // Measured floor, rounded down. Since `include` was added the
      // denominator covers every source file, including ones no test imports
      // (src/main.ts at 0%); before, only imported files counted (lines were
      // 87.36%). Branch coverage is the gap, mostly in the older services;
      // raise towards 80 over time.
      thresholds: {
        lines: 83,
        functions: 82,
        branches: 71,
        statements: 82,
      }
    },
  },
  resolve: {
    alias: [
      {
        find: '@',
        replacement: '/src',
      },
    ],
  },
});