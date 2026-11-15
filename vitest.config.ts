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
      all: true,
      // Not yet at 80 everywhere: branch coverage (72%) is the gap, mostly
      // in the older services. Thresholds are the measured floor after the
      // Sieve protocol tests landed (PR #9); raise towards 80 over time.
      thresholds: {
        lines: 86,
        functions: 86,
        branches: 72,
        statements: 85,
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