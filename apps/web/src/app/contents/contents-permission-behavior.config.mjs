/*
  N-197 の権限契約試験だけを、実buildへ当てて動かす設定。

  `pnpm --filter web test`（vitest）は `src` の下の `.test.ts` と `.test.tsx`
  しか見ない。この試験はブラウザが要るので同じ入れ物には入らない。
  **必須ゲートから外れたままにしないため、専用の設定を置いて `web-build` の
  工程から呼ぶ。** 前回の差し戻し理由の1つが
  「`.spec.mjs` は `pnpm --filter web test` と Required gate の対象外」だった。

  実行:
    pnpm --filter web build
    pnpm exec playwright test --config apps/web/src/app/contents/contents-permission-behavior.config.mjs
*/
import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.MEDIA_PERMISSION_PORT ?? 3109)
const BASE = process.env.MEDIA_PERMISSION_BASE ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: HERE,
  testMatch: 'contents-permission-behavior.spec.mjs',
  /* 応答の数を試験ごとに数えるので、並べずに1つずつ動かす。 */
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE,
  },
  webServer: {
    command: `node '${fileURLToPath(new URL('./contents-permission-behavior-server.mjs', import.meta.url)).replaceAll("'", "'\\''")}'`,
    url: `${BASE}/contents`,
    /*
      **使い回さない。** 前の実行が残っていると古い `out` を配り続け、
      直したはずの画面で試験が通ってしまう。実際にこの作業中、残っていた
      配信を掴んで「壊したのに通る」を1回出した。
    */
    reuseExistingServer: false,
    timeout: 60_000,
    env: { MEDIA_PERMISSION_PORT: String(PORT) },
  },
})
