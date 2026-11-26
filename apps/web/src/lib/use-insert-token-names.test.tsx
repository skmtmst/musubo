// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const load = vi.hoisted(() => vi.fn())
vi.mock('./template-references', async importOriginal => ({ ...await importOriginal<typeof import('./template-references')>(), loadTemplateReferences: load }))
import { useInsertTokenNames } from './use-insert-token-names'

afterEach(() => { cleanup(); vi.resetAllMocks() })

it('選んだアカウントの実名だけを出し、遅れた以前の答えは戻さない', async () => {
  const pending: Record<string, (value: unknown) => void> = {}
  load.mockImplementation((id: string) => new Promise(resolve => { pending[id] = resolve }))
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => useInsertTokenNames(id), { initialProps: { id: 'account-a' as string | null } })
  rerender({ id: 'account-b' })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
  await act(async () => { pending['account-a']({ friendFields: [], commonVars: [{ varKey: 'business_hours', name: '前の店の営業時間' }] }) })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
  await act(async () => { pending['account-b']({ friendFields: [{ fieldKey: 'pet_name', name: 'ペットの名前' }], commonVars: [{ varKey: 'business_hours', name: '営業時間' }] }) })
  expect(result.current).toEqual({ fields: { pet_name: 'ペットの名前' }, vars: { business_hours: '営業時間' }, varsComplete: true })
  rerender({ id: null })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
  expect(load.mock.calls.map(call => call[0])).toEqual(['account-a', 'account-b'])
})

it('読み込めない時は古い名前を使わず、表示側の名称未確認の口へ戻す', async () => {
  load.mockResolvedValueOnce({ friendFields: [], commonVars: [{ varKey: 'business_hours', name: '前の店の営業時間' }] }).mockRejectedValueOnce(new Error('読込失敗'))
  const { result, rerender } = renderHook(({ id }) => useInsertTokenNames(id), { initialProps: { id: 'account-a' } })
  await act(async () => { await Promise.resolve() })
  expect(result.current.vars).toEqual({ business_hours: '前の店の営業時間' })
  rerender({ id: 'account-b' })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
  await act(async () => { await Promise.resolve() })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
})

it('統括など所属が無い表示では、店の差し込み名を要求しない', () => {
  const { result } = renderHook(() => useInsertTokenNames(null))
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
  expect(load).not.toHaveBeenCalled()
})

it('所属を解除して同じアカウントへ戻っても、取り直す前の名前を再表示しない', async () => {
  load.mockResolvedValueOnce({ friendFields: [], commonVars: [{ varKey: 'hours', name: '以前の営業時間' }] }).mockImplementationOnce(() => new Promise(() => {}))
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => useInsertTokenNames(id), { initialProps: { id: 'account-a' as string | null } })
  await act(async () => { await Promise.resolve() })
  expect(result.current.vars).toEqual({ hours: '以前の営業時間' })
  rerender({ id: null })
  rerender({ id: 'account-a' })
  expect(result.current).toEqual({ fields: {}, vars: {}, varsComplete: false })
})

it('読み終えた共通情報だけ「名前なし」と言い切れ、停止中・期限切れ（代わりの値なし）は今は入らないと分かる', async () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  load.mockResolvedValueOnce({ friendFields: [], commonVars: [
    { varKey: 'closure_datetime', name: '臨時休業の日時', status: 'active', value: '12/1', validFrom: null, validUntil: null, fallbackValue: null, expiryBehavior: 'stop' },
    { varKey: 'campaign', name: 'キャンペーン', status: 'stopped', value: '春', validFrom: null, validUntil: null, fallbackValue: null, expiryBehavior: 'stop' },
    { varKey: 'sale_end', name: 'セールの終わり', status: 'active', value: '3/31', validFrom: null, validUntil: past, fallbackValue: null, expiryBehavior: 'stop' },
    { varKey: 'notice', name: 'お知らせ', status: 'active', value: '前の文', validFrom: null, validUntil: past, fallbackValue: '今の文', expiryBehavior: 'fallback' },
    { varKey: 'business_hours', name: '営業時間', status: 'active', value: '', validFrom: null, validUntil: null, fallbackValue: null, expiryBehavior: 'stop' },
    { varKey: 'store_phone', name: '店の電話番号', status: 'active', value: ' ', validFrom: null, validUntil: null, fallbackValue: null, expiryBehavior: 'stop' },
  ] })
  const { result } = renderHook(() => useInsertTokenNames('account-a'))
  expect(result.current.varsComplete).toBe(false)
  await act(async () => { await Promise.resolve() })
  expect(result.current.varsComplete).toBe(true)
  // 営業時間の空の値は Google から入ることがあるので言い切らない。空を送らない電話番号の空白は入らない。
  expect(Object.fromEntries(result.current.unavailableVars ?? [])).toEqual({ campaign: '停止中の', sale_end: '期限が切れている', store_phone: '値が空の' })
})

it('営業時間でも停止中・下書き・期限切れ（代わりの値なし）は、送信側と同じく先に入らないと分かる', async () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  load.mockResolvedValueOnce({ friendFields: [], commonVars: [
    { varKey: 'business_hours', name: '営業時間', status: 'stopped', value: '10時から', validFrom: null, validUntil: null, fallbackValue: null, expiryBehavior: 'stop' },
  ] }).mockResolvedValueOnce({ friendFields: [], commonVars: [
    { varKey: 'business_hours', name: '営業時間', status: 'active', value: '10時から', validFrom: null, validUntil: past, fallbackValue: null, expiryBehavior: 'stop' },
  ] })
  const { result, rerender } = renderHook(({ id }) => useInsertTokenNames(id), { initialProps: { id: 'account-a' } })
  await act(async () => { await Promise.resolve() })
  expect(Object.fromEntries(result.current.unavailableVars ?? [])).toEqual({ business_hours: '停止中の' })
  rerender({ id: 'account-b' })
  await act(async () => { await Promise.resolve() })
  expect(Object.fromEntries(result.current.unavailableVars ?? [])).toEqual({ business_hours: '期限が切れている' })
})
