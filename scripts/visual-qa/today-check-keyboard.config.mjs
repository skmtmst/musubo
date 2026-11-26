import { defineConfig } from '@playwright/test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: 'today-check-keyboard.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  use: { browserName: 'chromium' },
})
