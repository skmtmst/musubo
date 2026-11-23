import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, downloadApiFile, ApiError, describeSaveFailure } from './api'

const id = 'ab9daa00-9761-40a9-a9ee-a2c21bbe62c0'
const payload = (code: string) => ({ success: false, data: { currentVersion: 4 }, error: {
  code, message: '最新の内容を確認してください。', requestId: id,
  fieldErrors: [{ field: 'name', message: '名前を入力してください。' }],
} })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('管理画面の共通失敗契約', () => {
  it('未解決の差し込みだけは安全な変数名を残し、本文や余分なデータを渡さない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false, code: 'UNRESOLVED_TEMPLATE_VARIABLES',
      data: { variables: ['var.guest_count', 'var.closure_datetime', '<script>secret</script>'], content: '非公開の本文' },
    }), { status: 400 })))
    const error = await fetchApi('/api/chats/test/send', { method: 'POST', body: '{}' }).catch(e => e)
    expect(error).toMatchObject({ status: 400, code: 'UNRESOLVED_TEMPLATE_VARIABLES', data: { variables: ['var.guest_count', 'var.closure_datetime'] } })
  })
  it.each([400, 409, 422, 429, 502])('HTTP %iの状態・コード・追跡・待機・機械データを保つ', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload('VERSION_CONFLICT')), {
      status, headers: { 'Retry-After': '60', 'X-Request-ID': id },
    })))
    const error = await fetchApi('/api/test', { method: 'POST', body: '{}' }).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code: 'VERSION_CONFLICT', trackingId: id, retryAfterSeconds: 60 })
    expect(error.fields).toEqual(status === 400 || status === 422 ? { name: '名前を入力してください。' } : {})
    expect(error.data).toEqual([409, 429, 502].includes(status) ? { currentVersion: 4 } : undefined)
    if (status !== 502) expect(error.message).toBe('最新の内容を確認してください。')
    else expect(error.message).toBe('API error: 502')
  })
  it('JSONでない失敗は本文を見せず応答ヘッダーの追跡番号だけを使う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bearer secret</html>', { status: 500, headers: { 'X-Request-ID': id } })))
    await expect(fetchApi('/api/test')).rejects.toMatchObject({ status: 500, trackingId: id, message: 'API error: 500' })
  })
  it('CSV/Blobの失敗にも同じ欄の理由と追跡番号を付ける', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload('INVALID_INPUT')), { status: 422 })))
    await expect(downloadApiFile('/api/test', 'same.csv')).rejects.toMatchObject({ status: 422, code: 'INVALID_INPUT', trackingId: id, fields: { name: '名前を入力してください。' } })
  })
})


it.each(['保存できません D1_ERROR: SELECT secret FROM tenant', '入力を確認 Bearer sample-secret', '<script>表示</script>'])('通常の例外も内部原文を表示しない: %s', message => {
  const text = describeSaveFailure(new Error(message))
  expect(text).toMatch(/[ぁ-んァ-ヶ一-龠]/u)
  expect(text).not.toMatch(/D1_ERROR|SELECT secret|Bearer|sample-secret|<script>/)
})

it('具体的で安全な直し方は残す', () => {
  expect(describeSaveFailure(new Error('名前を入力してください。'))).toBe('名前を入力してください。')
})


it.each([400, 403, 409, 422, 500, 503])('ApiError HTTP %sにも英語・SQL・秘密値を表示しない', status => {
  for (const message of ['D1_ERROR: SELECT secret FROM tenant', '入力を確認 D1_ERROR: SELECT secret FROM tenant', '入力を確認 Bearer sample-secret', 'Internal server error']) {
    const text = describeSaveFailure(new ApiError(status, message))
    expect(text).toMatch(/[ぁ-んァ-ヶ一-龠]/u)
    expect(text).not.toMatch(/D1_ERROR|SELECT secret|Bearer|sample-secret|Internal server error|API error/)
  }
})

it.each([400, 409, 422])('HTTP %sの安全な直し方は共通化しても変えない', status => {
  expect(describeSaveFailure(new ApiError(status, '最新の内容を読み直してください。'))).toBe('最新の内容を読み直してください。')
})
