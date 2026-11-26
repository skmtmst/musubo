import { describe, expect, it } from 'vitest'
import {
  MOBILE_TABS,
  isMobileLoginReturn,
  isMobileShellPath,
  mobileHrefForPcPath,
  mobileTabForPath,
  visibleMobileTabs,
} from './mobile-shell'

describe('電話の専用の画面（/m）の住所', () => {
  it('/m と /m/… だけを電話の外枠にする（/mileage などは入れない）', () => {
    for (const path of ['/m', '/m/', '/m/chats', '/m/todo']) expect(isMobileShellPath(path), path).toBe(true)
    for (const path of ['/', '/mileage', '/mcp-connect', '/ops', '/chats', '/m-old', null, undefined]) expect(isMobileShellPath(path), String(path)).toBe(false)
  })

  it('4つのタブは対応する画面を開く', () => {
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual(['今日', 'トーク', '対応', 'もっと'])
    expect(mobileTabForPath('/m/today')?.id).toBe('today')
    expect(mobileTabForPath('/m/more')?.id).toBe('more')
    expect(mobileTabForPath('/m/chats')?.id).toBe('talk')
    expect(mobileTabForPath('/m/todo')?.id).toBe('todo')
    expect(mobileTabForPath('/m')).toBeNull()
  })

  it('受信箱の鍵が無い人にはトークのタブを出さない。権限の確認が済むまでは何も出さない', () => {
    expect(visibleMobileTabs(null)).toEqual([])
    expect(visibleMobileTabs(() => true).map((tab) => tab.id)).toEqual(['today', 'talk', 'todo', 'more'])
    expect(visibleMobileTabs((key) => key !== '/chats').map((tab) => tab.id)).toEqual(['today', 'todo', 'more'])
  })

  it('PC の受信箱の住所は /m の会話へ、/m に無い画面は null（PC の画面で開く）', () => {
    expect(mobileHrefForPcPath('/chats?friend=friend-1')).toBe('/m/chats?friend=friend-1')
    expect(mobileHrefForPcPath('/chats')).toBe('/m/chats')
    expect(mobileHrefForPcPath('/broadcasts/detail?id=b1')).toBeNull()
    expect(mobileHrefForPcPath('https://evil.invalid/chats?friend=x')).toBeNull()
  })

  it('ログインの戻り先の印は next=m だけ', () => {
    expect(isMobileLoginReturn('?next=m')).toBe(true)
    expect(isMobileLoginReturn('next=m')).toBe(true)
    expect(isMobileLoginReturn('?next=ops')).toBe(false)
    expect(isMobileLoginReturn('?next=/m')).toBe(false)
    expect(isMobileLoginReturn('')).toBe(false)
  })
})
