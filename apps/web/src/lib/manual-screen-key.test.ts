import { describe, expect, it } from 'vitest'
import { manualScreenKeyForPath } from './manual-screen-key'

describe('manualScreenKeyForPath', () => {
  it('主な画面を画面IDへ対応づける', () => {
    expect(manualScreenKeyForPath('/friends')).toBe('3-1')
    expect(manualScreenKeyForPath('/broadcasts')).toBe('6-1')
    expect(manualScreenKeyForPath('/auto-replies')).toBe('8-1')
    expect(manualScreenKeyForPath('/booking/bookings')).toBe('27-1')
    expect(manualScreenKeyForPath('/staff')).toBe('30-1')
  })

  it('詳細・作成など下位の画面は属する画面のIDへ寄せる', () => {
    expect(manualScreenKeyForPath('/friends/detail')).toBe('3-1')
    expect(manualScreenKeyForPath('/broadcasts/detail')).toBe('6-1')
    expect(manualScreenKeyForPath('/booking/menus/new')).toBe('28-1')
  })

  it('収載していない下位ルートは一番近い親の画面へ寄せる', () => {
    expect(manualScreenKeyForPath('/broadcasts/new/step2')).toBe('6-1')
  })

  it('対応表に足した主要画面が画面IDへ届く', () => {
    expect(manualScreenKeyForPath('/')).toBe('1-1')
    expect(manualScreenKeyForPath('/chats')).toBe('2-1')
    expect(manualScreenKeyForPath('/scenarios/detail')).toBe('5-1')
    expect(manualScreenKeyForPath('/friend-add-settings')).toBe('9-1')
    expect(manualScreenKeyForPath('/analytics')).toBe('20-1')
    expect(manualScreenKeyForPath('/common-actions/versions')).toBe('25-1')
    expect(manualScreenKeyForPath('/emergency')).toBe('32-1')
    expect(manualScreenKeyForPath('/getting-started')).toBe('34-1')
  })

  it('対応が無い画面は null を返す（リンク自体を出さない）', () => {
    expect(manualScreenKeyForPath('/login')).toBeNull()
    expect(manualScreenKeyForPath('/unknown-path')).toBeNull()
  })
})
