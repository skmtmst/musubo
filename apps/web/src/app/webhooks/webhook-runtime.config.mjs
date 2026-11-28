/*
  webhook-runtime.spec.ts（141行の実挙動契約）を必須ゲートから動かす設定。

  PR #1506 で入ったあと、専用の設定が無く、`pnpm --filter web test`（vitest）は
  `src` の下の `.test.ts(x)` しか見ないため、**どのワークフローからも一度も
  呼ばれていなかった**（#704）。`contents-permission-behavior.config.mjs` /
  `ec-commerce-issue-685.config.mjs` と同じ形で、専用の設定を置いて必須ゲート
  から呼ぶ。

  この試験だけは、書き出した `out` ではなく `next dev` に当てる。理由は、
  試験が `/api/line-accounts` を `route.fetch` で**実際に取りに行き**、
  返ってきた中身へ2つめのアカウントを足す作りだから。`out` は
  `NEXT_PUBLIC_API_URL` を組み込み済みで、その宛先は検証環境になる。
  そのまま当てると `route.fetch` が検証環境へ出てしまう。試験が書かれた
  ときの前提どおり、画面確認用のモックAPI（`scripts/visual-qa/mock-api.mjs`）
  へ向けた `next dev` に当てる。`owh-sheets` `owh-slack-order`
  `visual-qa-account` はどれもこのモックの固定値。

  実行:
    pnpm exec playwright test --config apps/web/src/app/webhooks/webhook-runtime.config.mjs
*/
import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { allocateTestPort } from '../../../scripts/test-port.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const API_PORT = await allocateTestPort(process.env.WEBHOOK_RUNTIME_API_PORT)
const PORT = await allocateTestPort(process.env.WEBHOOK_RUNTIME_PORT)
const API_BASE = `http://127.0.0.1:${API_PORT}`
const BASE = process.env.WEBHOOK_RUNTIME_BASE ?? `http://127.0.0.1:${PORT}`

/*
  試験本体は読み込み時に `process.env.WEBHOOK_RUNTIME_BASE` を読む。設定は
  ワーカー側でも読み込まれるので、ここで入れておけば宛先が揃う。
*/
process.env.WEBHOOK_RUNTIME_BASE = BASE
process.env.WEBHOOK_RUNTIME_API_PORT = String(API_PORT)
process.env.WEBHOOK_RUNTIME_PORT = String(PORT)

export default defineConfig({
  testDir: HERE,
  testMatch: 'webhook-runtime.spec.ts',
  /* 二重押し・遅延応答を要求の順番で組み立てるので、並べずに1つずつ動かす。 */
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE,
  },
  /*
    窓の幅を2つ動かす(#705)。

    #705 の不具合は**窓幅で出たり出なかったりした。**操作の吹き出しが次の行の
    ボタンにかぶさる量が幅で変わり、1280px では中心が 4px だけ空いていて
    偶然押せ、1600px では中心も覆われて押せなかった。1280px だけを見ていると
    同じ壊れ方を見逃すので、広いほうも必ず通す。
  */
  projects: [
    { name: '1280x720', use: { viewport: { width: 1280, height: 720 } } },
    { name: '1600x900', use: { viewport: { width: 1600, height: 900 } } },
  ],
  webServer: [
    {
      command: `node "${REPO_ROOT}scripts/visual-qa/mock-api.mjs"`,
      url: `${API_BASE}/api/webhooks/outgoing`,
      /*
        使い回さない。前の実行が残っていると古い固定値を返し続け、直したはず
        の画面で試験が通ってしまう（media permission の試験で実際に起きている）。
      */
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: String(API_PORT) },
    },
    {
      command: `pnpm --filter web exec next dev --port ${PORT}`,
      cwd: REPO_ROOT,
      url: `${BASE}/webhooks`,
      reuseExistingServer: false,
      /* 初回は /webhooks の組み立てが入るので、起動確認は長めに待つ。 */
      timeout: 240_000,
      env: { NEXT_PUBLIC_API_URL: API_BASE },
    },
  ],
})
