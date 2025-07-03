/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks', // Most compatible with Bun runtime
    poolOptions: {
      forks: {
        isolate: true,      // Ensure test isolation
        singleFork: false,  // Allow parallel execution
      },
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
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
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