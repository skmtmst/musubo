// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import { clearApiReadCache } from '@/lib/api/transport/read-cache'
import { FEATURE_DISABLED_EVENT } from '@/lib/api'
import { useFriendInfoData } from './use-friend-info-data'

/*
 * 受信箱のマイル欄は、店でマイルを使っていない（403 FEATURE_DISABLED・featureId=mileage）ときだけ
 * 「使っていない」にし、それ以外の失敗は取得失敗として再試行を出す。
 * 通信部は本物を通し、fetch だけを差し替える（featureId は通信部が応答ごとの ApiError に載せる）。
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let mileageResponse: () => Response
const net = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (/\/api\/friends\/[^/?]+\/mileage\?/.test(url)) return mileageResponse()
  return json({ success: false, error: 'not used' }, 404)
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearApiReadCache()
  net.mockClear()
  vi.stubGlobal('fetch', net)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const summary = { programId: 'p', programName: '店のマイル', available: 120, pending: 0, lifetimeEarned: 120, spent: 0 }

async function mileageFor(friendId: string) {
  const { result } = renderHook(() => useFriendInfoData({ friendId, accountId: 'acc-1' }))
  await waitFor(() => expect(result.current.mileage.kind).not.toBe('loading'))
  return result.current.mileage
}

it('マイル機能がオフ（403 FEATURE_DISABLED・featureId=mileage）なら「使っていない」にする', async () => {
  mileageResponse = () => json({ success: false, error: 'この機能は無効です', code: 'FEATURE_DISABLED', featureId: 'mileage' }, 403)
  expect(await mileageFor('friend-disabled')).toEqual({ kind: 'disabled' })
})

it.each([
  ['別の機能の FEATURE_DISABLED', () => json({ success: false, error: 'off', code: 'FEATURE_DISABLED', featureId: 'tags' }, 403)],
  ['featureId のない FEATURE_DISABLED', () => json({ success: false, error: 'off', code: 'FEATURE_DISABLED' }, 403)],
  ['権限不足の 403', () => json({ success: false, error: 'forbidden', code: 'FORBIDDEN' }, 403)],
  ['サーバーの失敗', () => json({ success: false, error: 'boom' }, 500)],
  ['成功でも中身が無い応答', () => json({ success: false, error: 'x' })],
])('%s は取得失敗のまま', async (_label, response) => {
  mileageResponse = response
  expect(await mileageFor(`friend-${_label}`)).toEqual({ kind: 'error' })
})

it('別のリクエストが同時にマイル停止を知らせても、この応答の featureId で判断する', async () => {
  mileageResponse = () => {
    window.dispatchEvent(new CustomEvent(FEATURE_DISABLED_EVENT, { detail: { featureId: 'mileage' } }))
    return json({ success: false, error: 'off', code: 'FEATURE_DISABLED', featureId: 'tags' }, 403)
  }
  expect(await mileageFor('friend-concurrent')).toEqual({ kind: 'error' })
})

it('通常は残高と記録を出す', async () => {
  mileageResponse = () => json({ success: true, data: { summary, history: [] } })
  expect(await mileageFor('friend-ok')).toEqual({ kind: 'data', summary, history: [] })
})
