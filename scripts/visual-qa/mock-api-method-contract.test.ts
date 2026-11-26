import { FEATURE_CATALOG } from '../../packages/shared/src/feature-catalog'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_API = join(HERE, 'mock-api.mjs')

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('空きポートを取得できませんでした'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

describe('Visual QA モックの HTTP method 受け渡し', () => {
  let child: ChildProcess
  let baseUrl: string

  beforeAll(async () => {
    const port = await availablePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [MOCK_API], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let lastError: unknown
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/__mock-fingerprint`)
        if (response.ok) return
      } catch (error) {
        lastError = error
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw lastError ?? new Error('Visual QA モックが起動しませんでした')
  })

  afterAll(() => {
    child?.kill('SIGTERM')
  })

  it('メール接続の確認は未接続の状態を返し、更新は許可しない', async () => {
    const url = `${baseUrl}/api/account-email/visual-qa-account/connection`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { status: 'disconnected', connectionId: null, address: null, mailbox: null, forwardingConfirmation: null, canReply: false } })
    const write = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(write.status).toBe(405)
  })

  it('撮影用の機能設定は全キーと版を返し、見本用の機能だけ有効にする', async () => {
    const response = await fetch(`${baseUrl}/api/settings/features`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.data.version).toBe(1)
    expect(Object.keys(body.data.features).sort()).toEqual(FEATURE_CATALOG.map(entry => entry.featureId).sort())
    for (const entry of FEATURE_CATALOG) {
      expect(body.data.features[entry.featureId]).toBe(entry.defaultEnabled || entry.featureId === 'webinars' || entry.featureId === 'affiliates')
    }
  })

  it('計測鍵を待たせず返し、同じアカウントは同じ鍵・別アカウントは別の鍵', async () => {
    const key = async (account: string) => {
      const response = await fetch(`${baseUrl}/api/site/tracking-key?account_id=${account}`, { signal: AbortSignal.timeout(2000) })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toMatchObject({ success: true, data: { accountId: account } })
      expect(body.data.trackingKey).toMatch(/^hk_[a-f0-9]{32}$/)
      return body.data.trackingKey as string
    }
    const first = await key('visual-account-one')
    expect(await key('visual-account-one')).toBe(first)
    expect(await key('visual-account-two')).not.toBe(first)
  })

  it.each([
    ['GET', '/api/forms', 200],
    ['POST', '/api/forms/drafts', 200],
    ['PUT', '/api/forms/form-1', 200],
    ['DELETE', '/api/forms/form-1', 200],
  ])('%s %s が未定義変数で止まらない', async (method, pathname, status) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method })
    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ success: true })
  })

  it('お客さまの画面のデザインは版と型を返し、保存は許可しない', async () => {
    const url = `${baseUrl}/api/account-settings/customer-look?accountId=visual-qa-account`
    const response = await fetch(url)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({success:true,data:{version:1,look:{preset:'line',primaryColor:null,backgroundColor:null,headingFont:'default'}}})
    const write = await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'visual-qa-account',expectedVersion:1,look:{preset:'warm'}})})
    expect(write.status).toBe(405)
  })

  it('初期設定の見本はダッシュボードの受付に遮られず、読込・確認・開始まで届く', async () => {
    for (const path of ['warnings', 'starter-set', 'starter-items', 'template-samples', 'resources']) {
      const response = await fetch(`${baseUrl}/api/dashboard/style/${path}?style=restaurant`)
      expect(response.status, path).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ success: true })
    }
    const activate = await fetch(`${baseUrl}/api/dashboard/style/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, items: [] }),
    })
    expect(activate.status).toBe(200)
    await expect(activate.json()).resolves.toMatchObject({ success: true, data: { complete: true } })
    const unknown = await fetch(`${baseUrl}/api/dashboard/style/unknown`)
    expect(unknown.status).toBe(404)
  })

  it('業種と空状態を切り替えても模擬の支払い・返金を本送信へ変えない', async () => {
    const root = `${baseUrl}/api/dashboard/style`
    const save = (qaEmpty: boolean) => fetch(root, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'salon', qaEmpty }),
    })
    try {
      for (const qaEmpty of [false, true]) {
        const selected = await save(qaEmpty)
        expect(selected.status).toBe(200)
        const schedule = await fetch(`${root}/schedule?style=salon&range=today`).then(response => response.json())
        expect(schedule.data.style).toBe('salon')
        expect(schedule.data.entries.length > 0).toBe(!qaEmpty)
      }
      const payment = await fetch(`${baseUrl}/api/booking/admin/payments/pay-1/send-link`, { method: 'POST' })
      await expect(payment.json()).resolves.toMatchObject({ success: true, data: { sent: false, simulation: true } })
      const refund = await fetch(`${baseUrl}/api/booking/payments/pay-1/refund`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 500, reason: '見本の返金', notifyLine: true, idempotencyKey: 'qa-refund' }),
      })
      expect(refund.status).toBe(200)
      await expect(refund.json()).resolves.toMatchObject({ success: true, data: {
        sent: false, simulation: true,
        refund: { amount: 500, notifyLine: true, notificationStatus: 'simulated', sent: false, simulation: true },
      } })
      const missing = await fetch(`${baseUrl}/api/booking/payments/missing-payment/refund`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '見本の返金', idempotencyKey: 'qa-missing-refund' }),
      })
      expect(missing.ok).toBe(false)
    } finally {
      await save(false)
    }
  })
})
