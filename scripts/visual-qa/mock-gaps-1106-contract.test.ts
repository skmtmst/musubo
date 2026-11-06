/*
 * 画面確認の偽 API の不足 3 件（FULL-SCREEN-PRECHECK-1106 の E2・E5・E6）の契約。
 * 偽 API を本当に立てて、本物の口の形どおりに返すか確かめる。
 * 形が違うと、画面が「読み込めませんでした」や件数の食い違いになる。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('画面確認の偽 API：先回り点検の不足3件', () => {
  let child: ChildProcess
  let baseUrl: string

  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('空きポートを取得できませんでした'))
        server.close((error) => error ? reject(error) : resolve(address.port))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [fileURLToPath(new URL('./mock-api.mjs', import.meta.url))], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    })
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        if ((await fetch(`${baseUrl}/__mock-fingerprint`)).ok) return
      } catch { /* 起動待ち */ }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('偽 API が起動しませんでした')
  })

  afterAll(() => { child?.kill('SIGTERM') })

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`)
    expect(res.ok).toBe(true)
    return res.json() as Promise<{ success: boolean; data: unknown }>
  }

  it('E2：/api/chats は ?status= で絞る（件数の口と行数が合う）', async () => {
    const all = await get('/api/chats')
    expect((all.data as unknown[]).length).toBeGreaterThan(1)
    const unread = await get('/api/chats?status=unread')
    const rows = unread.data as Array<{ status: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.status === 'unread')).toBe(true)
    expect(rows.length).toBeLessThan((all.data as unknown[]).length)
    // 札の口（quick-counts）も同じく絞り、行数と合う。
    const counts = await get('/api/chats/quick-counts?status=unread')
    expect((counts.data as { reply: number }).reply).toBe(rows.length)
  })

  it('E5：/api/auth/passkeys/self は配列で返す（実口と同じ形）', async () => {
    const res = await get('/api/auth/passkeys/self')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    const keys = res.data as Array<{ id: string; createdAt: string; lastUsedAt: string | null }>
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(typeof key.id).toBe('string')
      expect(typeof key.createdAt).toBe('string')
      expect(key.lastUsedAt === null || typeof key.lastUsedAt === 'string').toBe(true)
    }
  })

  it('E6：/api/conversions/report は求められた期間をそのまま返す', async () => {
    const res = await get('/api/conversions/report?from=2026-10-08&to=2026-11-06')
    expect(res.success).toBe(true)
    const report = res.data as { range: { from: string; to: string }; daily: Array<{ day: string }> }
    expect(report.range.from.slice(0, 10)).toBe('2026-10-08')
    expect(report.range.to.slice(0, 10)).toBe('2026-11-06')
    expect(report.daily.every((item) => item.day >= '2026-10-08' && item.day <= '2026-11-06')).toBe(true)
    // 期間なしは従来どおり別の画面の配列のまま（壊さない）。
    const plain = await get('/api/conversions/report')
    expect(Array.isArray(plain.data)).toBe(true)
  })
})
