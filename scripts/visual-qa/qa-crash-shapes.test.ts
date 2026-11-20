import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * 画面は本物の API の応答の形を前提に読むので、偽 API が
 * 既定の `{success, data:{items,…}}` に落ちると画面が落ちる。
 *
 * - /booking/menus … `c.value.staff is not iterable`（staff-menus が未定義）
 * - /form-submissions（管理者確認）… `e is not iterable`（unassigned が未定義）
 * - /chats（メールを開く）… `reading 'id'`（threads/:id が未定義）
 */
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

describe('点検で落ちた3画面の偽 API の形', () => {
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
    for (let attempt = 0; attempt < 250; attempt += 1) {
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

  it('/api/booking/admin/staff-menus は {staff:[{staff_id,matrix}]} を返す', async () => {
    const response = await fetch(`${baseUrl}/api/booking/admin/staff-menus?account_id=visual-qa-account`)
    expect(response.status).toBe(200)
    const body = await response.json() as { staff?: Array<{ staff_id?: string; matrix?: unknown[] }> }
    const staff = Array.isArray(body.staff) ? body.staff : []
    expect(staff.length).toBeGreaterThan(0)
    for (const entry of staff) {
      expect(typeof entry.staff_id).toBe('string')
      expect(Array.isArray(entry.matrix)).toBe(true)
    }
  })

  it('/api/forms/unassigned は配列を返す', async () => {
    const response = await fetch(`${baseUrl}/api/forms/unassigned?account_id=visual-qa-account`)
    expect(response.status).toBe(200)
    const body = await response.json() as { success?: boolean; data?: unknown }
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('/api/support/email/threads/:id は {thread,messages} を返す', async () => {
    const response = await fetch(`${baseUrl}/api/support/email/threads/mail-1`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      success?: boolean
      data?: { thread?: { id?: string }; messages?: unknown[] }
    }
    expect(body.success).toBe(true)
    expect(body.data?.thread?.id).toBe('mail-1')
    expect(Array.isArray(body.data?.messages)).toBe(true)
  })

  it('/api/support/email/threads/:id は載っていない ID を失敗にする', async () => {
    const response = await fetch(`${baseUrl}/api/support/email/threads/no-such-thread`)
    const body = await response.json() as { success?: boolean }
    expect(body.success).toBe(false)
  })
})
