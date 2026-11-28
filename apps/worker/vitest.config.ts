import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // @line-crm/line-sdk has main=dist/index.js but dist may not exist in
      // the worktree; point Vitest directly at the TS sources so tests resolve
      // without a build step.
      '@line-crm/line-sdk': path.resolve(__dirname, '../../packages/line-sdk/src/index.ts'),
      'cloudflare:workers': path.resolve(__dirname, './src/test-utils/cloudflare-workers-stub.ts'),
    },
  },
  test: {
    maxWorkers: process.env.CI ? 2 : 4,
    // Vitest 4 restoreAllMocks no longer clears standalone vi.fn call history.
    clearMocks: true,
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
