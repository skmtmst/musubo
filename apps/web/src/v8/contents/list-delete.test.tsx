// @vitest-environment happy-dom
/*
 * ★V8 登録メディア一覧（src/v8/contents/list.tsx）の削除の動き。
 * 1件ずつの削除確認（設計 `YfTfJ`）と、まとめて削除の途中交代・結果文を、
 * 画面を描いて押し、API へ届いた要求と画面の変化で確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())


vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const account = vi.hoisted(() => ({ id: 'account-a' }))
const toast = vi.hoisted(() => vi.fn())

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: null, loading: false }),
}))
vi.mock('@/components/shared/toast', async (importOriginal: () => Promise<typeof import('@/components/shared/toast')>) => ({
  ...(await importOriginal()),
  notifyToast: toast,
}))

import MediaLibraryListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Media = { id: string; filename: string; usageCount: number; lineAccountId?: string | null }
type Impact = {
  usageCount: number
  canDelete: boolean
  verified?: boolean
  checkedAt?: string
  references?: Array<{ kind: string; name: string | null; href: string | null; state: 'available' | 'unavailable' }>
}

const item = ({ id, filename, usageCount, lineAccountId = account.id }: Media) => ({
  id, lineAccountId, folderId: null, filename, kind: 'image', mimeType: 'image/png', sizeBytes: 1000,
  width: 10, height: 10, durationMs: null, usageCount, archivedAt: null, archiveReason: null,
  url: `https://example.test/${id}.png`, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
})
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const impactOf = (id: string, impact: Impact) => ({
  media: { id, filename: id, kind: 'image' },
  usageCount: impact.usageCount,
  references: (impact.references ?? []).map((ref) => ({ ...ref, scannedAt: '2026-09-01T00:00:00.000Z' })),
  checkedAt: impact.checkedAt ?? '2026-09-16T01:30:00.000Z',
  lastScannedAt: null,
  verified: impact.verified ?? true,
  canDelete: impact.canDelete,
  recommendedAction: impact.canDelete ? 'delete' : 'review_references',
})

type Call = { method: string; path: string; params: URLSearchParams }
let calls: Call[] = []
let media: Media[] = []
/** メディアごとの影響の返事。関数なら呼ぶたびに決める（読み直しで変わる場合）。 */
let impacts = new Map<string, Impact | (() => Impact | Promise<Impact>) | 'fail'>()
/** メディアごとの削除の返事（HTTP の状態）。無ければ 200。 */
let deleteStatus = new Map<string, number | (() => Promise<number>)>()
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  account.id = 'account-a'
  calls = []
  media = [{ id: 'm-1', filename: '秋の新商品.png', usageCount: 0 }]
  impacts = new Map()
  deleteStatus = new Map()
  toast.mockReset()
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/contents')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname, params: url.searchParams })
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { id: 'staff-1', role: 'admin' } })
    if (url.pathname === '/api/media/counts') return json({ success: true, data: { total: media.length, byKind: { image: media.length, video: 0, audio: 0, file: 0 }, unused: 0, archived: 0 } })
    if (url.pathname === '/api/media/quota') return json({ success: true, data: { usageBytes: 1, reservedBytes: 0, limitBytes: 100, remainingBytes: 99, usageRate: 0.01, state: 'normal' } })
    if (url.pathname === '/api/folders') return json({ success: true, data: [], unfiledCount: 0 })
    if (url.pathname === '/api/media' && method === 'GET') {
      const unusedOnly = url.searchParams.get('unusedOnly') === '1'
      const rows = media.filter((row) => !unusedOnly || row.usageCount === 0).map(item)
      return json({ success: true, data: { items: rows, total: rows.length, limit: Number(url.searchParams.get('limit') ?? 20), offset: 0 } })
    }
    const impactMatch = url.pathname.match(/^\/api\/media\/([^/]+)\/delete-impact$/)
    if (impactMatch) {
      const answer = impacts.get(impactMatch[1])
      if (answer === 'fail' || answer === undefined) return json({ success: false, error: 'scan failed' })
      const impact = typeof answer === 'function' ? await answer() : answer
      return json({ success: true, data: impactOf(impactMatch[1], impact) })
    }
    const deleteMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const answer = deleteStatus.get(deleteMatch[1]) ?? 200
      const status = typeof answer === 'function' ? await answer() : answer
      return status === 200 ? json({ success: true, data: null }) : json({ success: false, error: 'conflict' }, status)
    }
    return json({ success: false, error: 'not mocked' }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const render = async () => {
  await act(async () => root.render(<MediaLibraryListV8 />))
  await settle()
}
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('押す相手がありません')
  await act(async () => { (element as HTMLElement).click() })
  await settle()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
const reactClick = (element: Element | undefined) => {
  if (!element) throw new Error('押す相手がありません')
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  if (!key) throw new Error('操作を取得できません')
  return (element as unknown as Record<string, { onClick: () => void }>)[key].onClick
}
const buttonIn = (scope: ParentNode | null, text: string) =>
  [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim() === text)
const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) => row.textContent?.trim() === text)
const impactCalls = (id?: string) => calls.filter((call) => /\/delete-impact$/.test(call.path) && (!id || call.path.includes(`/${id}/`)))
const deleteCalls = () => calls.filter((call) => call.method === 'DELETE')
const openDeleteFor = async (filename: string) => {
  await click(host.querySelector(`button[aria-label="${filename}のその他操作"]`))
  await click(menuItem('削除する'))
}
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('1件ずつの削除確認（YfTfJ）', () => {
  it('メディアのアカウントが不明なら選択中のアカウントで補わない', async () => {
    media = [{ id: 'm-1', filename: '秋の新商品.png', usageCount: 0, lineAccountId: null }]
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await render(); await openDeleteFor('秋の新商品.png')
    expect(dialog()?.textContent).toContain('名前を確認できません')
  })
  it('一覧を出しただけでは使用先を読まず、窓を開けてから選択中のアカウントで読む', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await render()
    expect(host.textContent).toContain('秋の新商品.png')
    expect(impactCalls()).toHaveLength(0)

    await openDeleteFor('秋の新商品.png')
    expect(impactCalls('m-1')).toHaveLength(1)
    expect(impactCalls('m-1')[0].params.get('accountId')).toBe('account-a')
    expect(dialog()?.textContent).toContain('「秋の新商品.png」を削除しますか？')
    expect(dialog()?.textContent).toContain('LINEアカウント')
    expect(dialog()?.textContent).toContain('環境')
    expect(dialog()?.textContent).toContain('どこでも使っていません。')
  })

  it('撮影の押し口は「…」の削除項目に付き、窓は YfTfJ の印を持つ', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await render()
    await click(host.querySelector('button[aria-label="秋の新商品.pngのその他操作"]'))
    const deleteItem = menuItem('削除する')
    expect(deleteItem?.getAttribute('data-qa-open')).toBe('YfTfJ')
    // 削除は「…」の中の危ない操作。札の上にゴミ箱を直に置かない。
    expect(deleteItem?.closest('[data-menu-group]')?.getAttribute('data-menu-group')).toBe('destructive')
    expect(host.querySelector('button[aria-label="秋の新商品.pngを削除"]')).toBeNull()
    await click(deleteItem)
    expect(dialog()?.querySelector('[data-design-node="YfTfJ"]')).not.toBeNull()
  })

  it('確かめて押すと選択中のアカウントで DELETE し、一覧を読み直す', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await render()
    await openDeleteFor('秋の新商品.png')
    const listReads = calls.filter((call) => call.path === '/api/media').length
    await click(buttonIn(dialog(), '削除する'))
    expect(deleteCalls()).toHaveLength(1)
    expect(deleteCalls()[0].path).toBe('/api/media/m-1')
    expect(deleteCalls()[0].params.get('accountId')).toBe('account-a')
    expect(dialog()).toBeNull()
    expect(calls.filter((call) => call.path === '/api/media').length).toBeGreaterThan(listReads)
  })

  it('使用先が読めないときは消させず、読み直しの口を出す', async () => {
    impacts.set('m-1', 'fail')
    await render()
    await openDeleteFor('秋の新商品.png')
    expect(dialog()?.textContent).toContain('使われている場所を確認できませんでした')
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()

    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await click(buttonIn(dialog(), 'もう一度読み込む'))
    expect(impactCalls('m-1')).toHaveLength(2)
    expect(buttonIn(dialog(), '削除する')).toBeDefined()
  })

  it('消せないときは「削除しますか？」と聞かず、押し口ごと出さない。確かめた時刻と使用先の確認を書く', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    impacts.set('m-1', {
      usageCount: 2,
      canDelete: false,
      checkedAt: '2026-09-16T01:30:00.000Z',
      references: [
        { kind: 'template', name: '秋のごあいさつ', href: '/templates/edit?id=t-1', state: 'available' },
        { kind: 'broadcast', name: null, href: null, state: 'unavailable' },
      ],
    })
    await render()
    await openDeleteFor('秋の新商品.png')
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('「秋の新商品.png」は削除できません')
    expect(text).not.toContain('削除しますか？')
    expect(text).toContain('いま 2か所で使われています。')
    expect(text).toContain('使われているあいだは削除できません')
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()
    // 確かめた時点（日本時間）と使用先の確認。
    expect(text).toContain('9月16日 10:30 時点で')
    expect(text).toContain('登録メディアの使用先を確認しました')
    // 開ける先があるときだけリンクにする。無い画面へ送らない。
    const links = [...(dialog()?.querySelectorAll('a') ?? [])]
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['ここを開く', '/templates/edit?id=t-1']])
    expect(text).toContain('開けません')
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('使用中は削除を止め、使用先の確認だけを示す', async () => {
    impacts.set('m-1', { usageCount: 1, canDelete: false, references: [{ kind: 'template', name: '秋のごあいさつ', href: null, state: 'available' }] })
    await render()
    await openDeleteFor('秋の新商品.png')
    expect(dialog()?.textContent).toContain('秋のごあいさつ')
    expect(dialog()?.textContent).not.toContain('差し替え')
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()
  })

  it('409 は「いま使われ始めた」と言い、使用先を読み直してから見せる', async () => {
    let usage = 0
    impacts.set('m-1', () => ({ usageCount: usage, canDelete: usage === 0, references: usage ? [{ kind: 'scenario', name: '新規登録7日間', href: null, state: 'available' }] : [] }))
    deleteStatus.set('m-1', 409)
    await render()
    await openDeleteFor('秋の新商品.png')
    usage = 1
    await click(buttonIn(dialog(), '削除する'))
    expect(dialog()?.textContent).toContain('いま使われ始めたため、削除できませんでした。使用先を読み直しました。')
    expect(impactCalls('m-1')).toHaveLength(2)
    expect(dialog()?.textContent).toContain('新規登録7日間')
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()
  })
})

describe('使用状況に合わせた削除確認の案内', () => {
  it.each([true, undefined])('確認済みの未使用では使用先を外す案内を出さず、時刻と削除の門を保つ（verified=%s）', async (verified) => {
    impacts.set('m-1', { usageCount: 0, canDelete: true, verified })
    if (verified === undefined) {
      const original = fetch
      vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args)
        if (!String(args[0]).includes('/delete-impact')) return response
        const payload = await response.json()
        delete payload.data.verified
        return json(payload)
      })
    }
    await render()
    await openDeleteFor('秋の新商品.png')
    const text = dialog()?.textContent ?? ''
    expect(text).toContain('どこでも使っていません。')
    expect(text).not.toContain('使われている場所から外すと削除できます。')
    expect(text).not.toContain('差し替え')
    expect(text).toContain('時点で、登録メディアの使用先を確認しました。')
    expect(buttonIn(dialog(), '削除する')).toBeDefined()
    expect(impactCalls('m-1')).toHaveLength(1)
    expect(impactCalls('m-1')[0].params.get('accountId')).toBe('account-a')
    expect(deleteCalls()).toHaveLength(0)
  })

  it('使用中は使用先を外す案内を示し、削除できない', async () => {
    impacts.set('m-1', { usageCount: 1, canDelete: false, verified: true, references: [{ kind: 'template', name: '秋のごあいさつ', href: '/templates?id=t-1', state: 'available' }] })
    await render()
    await openDeleteFor('秋の新商品.png')
    expect(dialog()?.textContent).toContain('いま 1か所で使われています。')
    expect(dialog()?.textContent).toContain('使われている場所から外すと削除できます。')
    expect(dialog()?.textContent).not.toContain('差し替え')
    expect(dialog()?.textContent).toContain('秋のごあいさつ')
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()
    expect(deleteCalls()).toHaveLength(0)
  })

  it('未確認の0件は未使用と断定せず、読み直しを残して削除できない', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: false, verified: false })
    await render()
    await openDeleteFor('秋の新商品.png')
    expect(dialog()?.textContent).toContain('使われている場所を確かめられませんでした。')
    expect(dialog()?.textContent).not.toContain('どこでも使っていません。')
    expect(dialog()?.textContent).not.toContain('使われている場所から外すと削除できます。')
    expect(dialog()?.textContent).not.toContain('登録メディアの使用先を確認しました。')
    expect(buttonIn(dialog(), 'もう一度読み込む')).toBeDefined()
    expect(buttonIn(dialog(), '削除する')).toBeUndefined()
    expect(impactCalls('m-1')).toHaveLength(1)
    expect(deleteCalls()).toHaveLength(0)
  })
})

describe('遅れて返った結果の照合', () => {
  it('同じメディアの窓を再表示した後は古い削除操作を受け付けない', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    await render(); await openDeleteFor('秋の新商品.png')
    const oldClick = reactClick(buttonIn(dialog(), '削除する'))
    await click(dialog()?.querySelector('button[aria-label="閉じる"]'))
    await openDeleteFor('秋の新商品.png')
    await act(async () => { oldClick() }); await settle()
    expect(deleteCalls()).toHaveLength(0)
    await click(buttonIn(dialog(), '削除する'))
    expect(deleteCalls()).toHaveLength(1)
  })
  it('A を読み込み中に閉じて B を開くと、あとから返る A の結果を B の窓に映さない', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    const slowA = deferred<Impact>()
    impacts.set('m-a', () => slowA.promise)
    impacts.set('m-b', { usageCount: 0, canDelete: true })
    await render()
    await openDeleteFor('A.png')
    await click(dialog()?.querySelector('button[aria-label="閉じる"]'))
    await openDeleteFor('B.png')
    expect(dialog()?.textContent).toContain('「B.png」を削除しますか？')

    await act(async () => { slowA.resolve({ usageCount: 3, canDelete: false }) })
    await settle()
    expect(dialog()?.textContent).toContain('「B.png」を削除しますか？')
    expect(dialog()?.textContent).not.toContain('3か所')
    expect(buttonIn(dialog(), '削除する')).toBeDefined()
  })

  it('同じメディアの窓をもう一度開いたとき、前の読み込みの返事を新しい窓に映さない', async () => {
    const first = deferred<Impact>()
    let round = 0
    impacts.set('m-1', () => { round += 1; return round === 1 ? first.promise : { usageCount: 0, canDelete: true } })
    await render()
    await openDeleteFor('秋の新商品.png')
    await click(dialog()?.querySelector('button[aria-label="閉じる"]'))
    await openDeleteFor('秋の新商品.png')
    expect(buttonIn(dialog(), '削除する')).toBeDefined()

    await act(async () => { first.resolve({ usageCount: 4, canDelete: false }) })
    await settle()
    expect(dialog()?.textContent).not.toContain('4か所')
    expect(buttonIn(dialog(), '削除する')).toBeDefined()
  })

  it('409 の再取得中に画面を再表示しても古い応答を映さない', async () => {
    const reread = deferred<Impact>()
    let round = 0
    impacts.set('m-1', () => {
      round += 1
      if (round === 2) return reread.promise
      return { usageCount: 0, canDelete: true }
    })
    deleteStatus.set('m-1', 409)
    await render()
    await openDeleteFor('秋の新商品.png')
    await click(buttonIn(dialog(), '削除する'))
    expect(dialog()?.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')?.disabled).toBe(true)
    await act(async () => { root.render(null) })
    await settle()
    await render()
    await openDeleteFor('秋の新商品.png')
    expect(round).toBe(3)
    expect(dialog()?.textContent).toContain('どこでも使っていません。')

    await act(async () => { reread.resolve({ usageCount: 5, canDelete: false }) })
    await settle()
    expect(dialog()?.textContent).not.toContain('5か所')
    expect(dialog()?.textContent).toContain('どこでも使っていません。')
  })

  it('アカウントを切り替えたら窓を閉じ、前のアカウントの削除結果を映さない', async () => {
    impacts.set('m-1', { usageCount: 0, canDelete: true })
    const slowDelete = deferred<number>()
    deleteStatus.set('m-1', () => slowDelete.promise)
    await render()
    await openDeleteFor('秋の新商品.png')
    await click(buttonIn(dialog(), '削除する'))

    account.id = 'account-b'
    await act(async () => root.render(<MediaLibraryListV8 />))
    await settle()
    expect(dialog()).toBeNull()

    await act(async () => { slowDelete.resolve(500) })
    await settle()
    expect(document.body.textContent).not.toContain('削除できませんでした')
    expect(dialog()).toBeNull()
  })
})

describe('まとめて削除', () => {
  const selectAll = async () => {
    await click(host.querySelector('input[aria-label="A.pngを選ぶ"]'))
    await click(host.querySelector('input[aria-label="B.pngを選ぶ"]'))
  }

  it('一括削除の窓を再表示した後は古い操作を受け付けない', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    await render(); await selectAll()
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    const oldClick = reactClick(buttonIn(dialog(), '削除する'))
    await click(buttonIn(dialog(), 'キャンセル'))
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    await act(async () => { oldClick() }); await settle()
    expect(deleteCalls()).toHaveLength(0)
    await click(buttonIn(dialog(), '削除する'))
    expect(deleteCalls()).toHaveLength(2)
  })

  it('一括削除中にアカウントを行き来したら残りを消さない', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    const firstDelete = deferred<number>()
    deleteStatus.set('m-a', () => firstDelete.promise)
    await render(); await selectAll()
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    await click(buttonIn(dialog(), '削除する'))
    account.id = 'account-b'; await render()
    account.id = 'account-a'; await render()
    await act(async () => { firstDelete.resolve(200) }); await settle()
    expect(deleteCalls().map(call => call.path)).toEqual(['/api/media/m-a'])
  })

  it('M2 処理中は何件目かを読み上げ欄に出し、失敗した1件があっても残りへ進む', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    const firstDelete = deferred<number>()
    deleteStatus.set('m-a', () => firstDelete.promise)
    deleteStatus.set('m-b', 409)
    await render()
    await selectAll()
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    expect(dialog()?.textContent).toContain('2 件のメディアを削除しますか？')
    expect(dialog()?.textContent).toContain('LINEアカウント')
    expect(dialog()?.textContent).toContain('環境')
    await click(buttonIn(dialog(), '削除する'))
    const progress = dialog()?.querySelector('[aria-live="polite"]')
    expect(progress?.textContent).toContain('処理中…（0/2 件）')

    await act(async () => { firstDelete.resolve(200) })
    await settle()
    expect(deleteCalls().map((call) => call.path)).toEqual(['/api/media/m-a', '/api/media/m-b'])
    expect(dialog()).toBeNull()
    // 一部失敗は成功の知らせにしない。
    expect(toast).not.toHaveBeenCalled()
  })

  it('全部消せたら成功の知らせだけを出す', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    await render()
    await selectAll()
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    await click(buttonIn(dialog(), '削除する'))
    expect(toast).toHaveBeenCalledWith('削除しました（2 件）')
    expect(host.textContent).not.toContain('失敗')
  })

  it('M2 途中でアカウントが変わったら処理中の窓を閉じて抜け、残りを消さない', async () => {
    media = [{ id: 'm-a', filename: 'A.png', usageCount: 0 }, { id: 'm-b', filename: 'B.png', usageCount: 0 }]
    const firstDelete = deferred<number>()
    deleteStatus.set('m-a', () => firstDelete.promise)
    await render()
    await selectAll()
    await click(buttonIn(document, '選択したメディアを削除（2）'))
    await click(buttonIn(dialog(), '削除する'))

    account.id = 'account-b'
    await act(async () => root.render(<MediaLibraryListV8 />))
    await settle()
    await act(async () => { firstDelete.resolve(200) })
    await settle()
    expect(deleteCalls().map((call) => call.path)).toEqual(['/api/media/m-a'])
    expect(dialog()).toBeNull()
    expect(document.body.textContent).not.toContain('処理中…（')
    expect(toast).not.toHaveBeenCalled()
  })
})
