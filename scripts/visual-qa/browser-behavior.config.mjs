import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: fileURLToPath(new URL('../..', import.meta.url)),
  testMatch: [
    'scripts/visual-qa/capture.spec.mjs',
    'scripts/visual-qa/setup-center.spec.mjs',
    'scripts/visual-qa/first-message-dashboard.spec.mjs',
    'scripts/visual-qa/friends-interactions.spec.mjs',
    'scripts/visual-qa/inbox-narrow.spec.mjs',
    'scripts/visual-qa/busy-buttons.spec.mjs',
    'apps/web/src/app/chats/inbox-673-behavior.spec.mjs',
    'apps/web/src/app/contents/vars/new/page.interaction.spec.ts',
  ],
  workers: 1, retries: 0, timeout: 45000, expect: { timeout: 10000 },
  updateSnapshots: 'none', reporter: 'list',
  outputDir: process.env.BROWSER_BEHAVIOR_OUTPUT ?? fileURLToPath(new URL('../../test-results/browser-behavior', import.meta.url)),
  use: { browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
