// @vitest-environment happy-dom
import { expectLockedFolderMenu } from '@/test-utils/permission-locked-control'
/*
 * ★V8 登録メディア一覧（src/v8/contents/list.tsx）の見え方と絞り込みの動き。
 * 道具の段・数の帯・札の中身・選べる札・0件の言い分け・フォルダの列を、
 * 画面を描いて押し、API へ届いた要求と画面の変化で確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())


vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fixture = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'staff' }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }),
}))

import MediaLibraryListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  lineAccountId: 'account-a', archivedAt: null, archiveReason: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
}
const PHOTO = { ...base, id: 'm-photo', folderId: 'mf-photo', filename: '秋の新商品.jpg', kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1200000, width: 1200, height: 800, durationMs: null, usageCount: 2, url: 'https://example.test/p.jpg' }
const MOVIE = { ...base, id: 'm-movie', folderId: null, filename: '使い方ガイド.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 38000000, width: null, height: null, durationMs: 60000, usageCount: 0, url: 'https://example.test/m.mp4' }
const UNKNOWN = { ...base, id: 'm-doc', folderId: null, filename: 'メニュー表.pdf', kind: 'file', mimeType: 'application/pdf', sizeBytes: 2100000, width: null, height: null, durationMs: null, url: 'https://example.test/d.pdf' }

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { method: string; path: string; params: URLSearchParams }
let calls: Call[] = []
let media: Array<Record<string, unknown>> = []
/** 一覧の口が返す総数。ページ送りを試すときだけ件数より大きくする。 */
let listTotal: number | null = null
/** 一覧本体の返事を止めておく口。読み込み中の表示を見るときだけ使う。 */
let listGate: Promise<void> | null = null
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  fixture.role = 'admin'
  calls = []
  media = [PHOTO, MOVIE, UNKNOWN]
  listTotal = null
  listGate = null
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/contents')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname, params: url.searchParams })
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { id: 'staff-1', role: fixture.role } })
    if (url.pathname === '/api/media/counts') return json({ success: true, data: { total: 3, byKind: { image: 1, video: 1, audio: 0, file: 1 }, unused: 1, archived: 0 } })
    if (url.pathname === '/api/media/quota') {
      return json({ success: true, data: { usageBytes: 3_221_225_472, reservedBytes: 0, limitBytes: 10_737_418_240, remainingBytes: 7_516_192_768, usageRate: 0.3, state: 'normal' } })
    }
    if (url.pathname === '/api/folders' && method === 'GET') {
      return json({ success: true, data: [{ id: 'mf-photo', kind: 'media', accountId: 'account-a', name: '01_商品写真', parentId: null, displayOrder: 0, color: '#2f6fde', itemCount: 1, revision: 1 }], unfiledCount: 2 })
    }
    if (url.pathname.startsWith('/api/folders/') && method === 'DELETE') return json({ success: true, data: null })
    if (url.pathname === '/api/media' && method === 'GET') {
      const params = url.searchParams
      if (listGate && params.get('limit') !== '1') await listGate
      // 絞り込みが1つでも付いたら0件を返す（0件の言い分けを見るため）。
      const filtered = ['kind', 'folderId', 'query', 'unusedOnly', 'nearLimitOnly', 'archived'].some((key) => params.has(key))
      const rows = filtered && params.get('limit') !== '1' ? [] : media
      return json({ success: true, data: { items: rows, total: filtered ? 0 : listTotal ?? rows.length, limit: Number(params.get('limit') ?? 20), offset: Number(params.get('offset') ?? 0) } })
    }
    return json({ success: false, error: 'not mocked' }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
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
const button = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((row) => row.textContent?.trim())
const choose = async (label: string, option: string) => {
  await click(host.querySelector(`button[aria-label="${label}"]`))
  const row = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((candidate) => candidate.textContent?.trim() === option)
  if (!row) throw new Error(`選べません: ${option}`)
  await click(row.querySelector('button') ?? row)
}
const typeSearch = async (value: string) => {
  await act(async () => {
    const input = host.querySelector('input[aria-label="ファイル名で探す"]') as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) })
  await settle()
}
/** 数の帯の1件読みを除いた、一覧本体の最後の要求。 */
const lastListRead = () => calls.filter((call) => call.path === '/api/media' && call.params.get('limit') !== '1').at(-1)!

describe('道具の段', () => {
  it('1行目は検索、2行目の左は種類の札、右は並べ方・よく使う絞り込み・表示件数', async () => {
    await render()
    const toolbar = host.querySelector('[data-list-toolbar][data-shared-part="list-toolbar"]')!
    const search = toolbar.querySelector('[data-toolbar-search] input[aria-label="ファイル名で探す"]') as HTMLInputElement
    expect(search.placeholder).toBe('ファイル名で探す')
    const chips = toolbar.querySelector('[role="group"][aria-label="種類と使い方で絞り込む"]')!
    expect(chips.closest('[data-toolbar-trailing]')).toBeNull()
    expect(chips.closest('[data-toolbar-row]')).not.toBe(search.closest('[data-toolbar-row]'))
    const trailing = toolbar.querySelector('[data-toolbar-trailing]')!
    for (const name of ['並べ方', 'よく使う絞り込み', '表示件数']) {
      expect(trailing.querySelector(`[aria-label="${name}"]`), `${name} が2行目の右に無い`).not.toBeNull()
    }
  })

  it('検索語は一覧の口へ渡し、1ページ目から読み直す', async () => {
    listTotal = 45
    await render()
    await click(host.querySelector('button[aria-label="次のページ"], [data-list-pager] button[aria-label*="次"]'))
    expect(lastListRead().params.get('offset')).toBe('20')
    await typeSearch('秋')
    expect(lastListRead().params.get('query')).toBe('秋')
    // 範囲の補正で後から戻るのではなく、検索語を載せた最初の要求から1ページ目で読む。
    const searched = calls.filter((call) => call.path === '/api/media' && call.params.get('query') === '秋' && call.params.get('limit') !== '1')
    expect(searched.length).toBeGreaterThan(0)
    expect(searched.map((call) => call.params.get('offset'))).toEqual(searched.map(() => null))
  })

  it('並べ方は「よく使う絞り込み」の並び順から選び、一覧の口へ sort で渡す', async () => {
    await render()
    expect(lastListRead().params.get('sort')).toBe('newest')
    await choose('よく使う絞り込み', '並び：使われている順')
    expect(lastListRead().params.get('sort')).toBe('usage')
    await choose('よく使う絞り込み', '並び：容量が大きい順')
    expect(lastListRead().params.get('sort')).toBe('size')
  })

  it('表示件数は limit、ページ送りは offset で口へ渡し、表の下に範囲を出す', async () => {
    listTotal = 45
    await render()
    expect(lastListRead().params.get('limit')).toBe('20')
    expect(host.querySelector('[data-list-pager]')?.textContent).toContain('45件中 1〜20件')
    await choose('表示件数', '50件表示')
    expect(lastListRead().params.get('limit')).toBe('50')
    await choose('表示件数', '10件表示')
    await click(host.querySelector('[data-list-pager] button[aria-label="2ページ目"], [data-list-pager] button[aria-label*="次"]'))
    expect(lastListRead().params.get('limit')).toBe('10')
    expect(lastListRead().params.get('offset')).toBe('10')
    expect(host.querySelector('[data-list-pager]')?.textContent).toContain('45件中 11〜20件')
  })

  it('「どこでも使っていない」の札は unusedOnly で読み、外すと全件へ戻る', async () => {
    await render()
    const chip = button('どこでも使っていない 1')!
    await click(chip)
    expect(lastListRead().params.get('unusedOnly')).toBe('1')
    await click(button('どこでも使っていない 1'))
    expect(lastListRead().params.get('unusedOnly')).toBeNull()
  })

  it('よく使う絞り込みから「上限に近いもの」「アーカイブ済み」「動画だけ」を口へ渡す', async () => {
    await render()
    await choose('よく使う絞り込み', '上限に近いものだけ')
    expect(lastListRead().params.get('nearLimitOnly')).toBe('1')
    await choose('よく使う絞り込み', 'アーカイブ済みだけ')
    expect(lastListRead().params.get('archived')).toBe('only')
    expect(lastListRead().params.get('nearLimitOnly')).toBeNull()
    await choose('よく使う絞り込み', '動画だけ')
    expect(lastListRead().params.get('kind')).toBe('video')
    expect(lastListRead().params.get('archived')).toBeNull()
  })
})

describe('読み込みの状態', () => {
  it('一覧の返事を待つ間は読み込み中の状態（読み上げは「読み込んでいます」）を出し、返ったら札に替える', async () => {
    let release: () => void = () => {}
    listGate = new Promise<void>((resolve) => { release = resolve })
    await render()
    expect(host.querySelector('[data-design-node="O7hUt7"]')).not.toBeNull()
    expect(host.querySelector('[data-list-state="loading"][aria-busy="true"]')?.getAttribute('aria-label')).toBe('読み込んでいます')
    expect(host.textContent).not.toContain('秋の新商品.jpg')
    await act(async () => { release() })
    await settle()
    expect(host.querySelector('[data-list-state="loading"]')).toBeNull()
    expect(host.textContent).toContain('秋の新商品.jpg')
  })
})

describe('数の帯と札', () => {
  it('数の帯は4マスを集計の実値で出し、容量は保存容量の口の値と上限の割合を出す', async () => {
    await render()
    const band = host.querySelector('[aria-label="登録メディアの集計"]')!
    const text = band.textContent ?? ''
    for (const title of ['登録メディア', 'どこでも使っていない', '使っている容量', 'アーカイブ']) expect(text).toContain(title)
    expect(text).toContain('画像1・音声0・動画1・PDF1')
    expect(text).toContain('使っている容量3.0GB')
    expect(text).toContain('上限 10.0 GB の 30%')
    expect(calls.some((call) => call.path === '/api/media/quota' && call.params.get('accountId') === 'account-a')).toBe(true)
  })

  it('札は種別と容量・使用先を出し、未取得の使用数を0件に見せない', async () => {
    await render()
    const cardOf = (name: string) => host.querySelector(`button[aria-label="${name}のプレビューを見る"]`)!.parentElement!
    const photo = cardOf('秋の新商品.jpg')
    expect(photo.textContent).toContain('使用先：2 か所')
    expect(photo.querySelector('p[title]')?.getAttribute('title')).toBe('JPG ／ 1200×800 ／ 1.1 MB')
    const movie = cardOf('使い方ガイド.mp4')
    expect(movie.textContent).toContain('使用先：どこでも使っていない')
    expect(movie.querySelector('p[title]')?.getAttribute('title')).toBe('MP4 ／ 60秒 ／ 36.2 MB')
    const doc = cardOf('メニュー表.pdf')
    expect(doc.textContent).toContain('使用先：確かめられません')
    expect(doc.textContent).not.toContain('どこでも使っていない')
    expect(doc.querySelector('p[title]')?.getAttribute('title')).toBe('PDF ／ 2.0 MB')
  })

  it('使っている・使用先が分からない札は選べず、理由を添える。使っていない札だけ選べて一括の帯が出る', async () => {
    await render()
    const box = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${name}を選ぶ"]`)!
    expect(box('秋の新商品.jpg').disabled).toBe(true)
    expect(box('秋の新商品.jpg').closest('[title]')?.getAttribute('title')).toBe('使用先から外すまで削除できません')
    expect(box('メニュー表.pdf').disabled).toBe(true)
    expect(box('メニュー表.pdf').closest('[title]')?.getAttribute('title')).toBe('使用先を確認できないため選べません')
    expect(box('使い方ガイド.mp4').disabled).toBe(false)
    await click(box('使い方ガイド.mp4'))
    expect(button('選択したメディアを削除（1）')).toBeDefined()
    expect(host.textContent).toContain('1件を選択中')
  })

  it('管理者の「…」は全部の操作を出し、削除は危ない操作として区切りの下に置く', async () => {
    await render()
    await click(host.querySelector('button[aria-label="使い方ガイド.mp4のその他操作"]'))
    expect(menuItems()).toEqual(['プレビュー', '使用箇所を見る', 'ダウンロード', '名前を変える', 'フォルダへ移す', 'アーカイブ', '別のメディアに差し替える', '削除する'])
    const deleteItem = [...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent?.trim() === '削除する')
    expect(deleteItem?.closest('[data-menu-group]')?.getAttribute('data-menu-group')).toBe('destructive')
  })

  it('閲覧のみの「…」はプレビューとダウンロードだけで、選ぶ札も出さない', async () => {
    fixture.role = 'staff'
    await render()
    await click(host.querySelector('button[aria-label="使い方ガイド.mp4のその他操作"]'))
    expect(menuItems()).toEqual(['プレビュー', 'ダウンロード'])
    expect(host.querySelector('input[aria-label="使い方ガイド.mp4を選ぶ"]')).toBeNull()
  })
})

describe('0件の言い分け（R38）', () => {
  it('まだ1件も無いときは登録の口を出し、「条件を外す」は出さない', async () => {
    media = []
    await render()
    expect(host.textContent).toContain('まだメディアがありません')
    expect(button('最初のメディアを登録する')).toBeDefined()
    expect(button('条件を外す')).toBeUndefined()
  })

  const filters: Array<[string, () => Promise<void>, string]> = [
    ['検索', () => typeSearch('なし'), 'query'],
    ['どこでも使っていない', () => click(button('どこでも使っていない 1')), 'unusedOnly'],
    ['上限に近いもの', () => choose('よく使う絞り込み', '上限に近いものだけ'), 'nearLimitOnly'],
    ['アーカイブ済み', () => choose('よく使う絞り込み', 'アーカイブ済みだけ'), 'archived'],
    ['種類', () => choose('よく使う絞り込み', '音声だけ'), 'kind'],
    ['フォルダ', () => click([...host.querySelectorAll('nav[aria-label="フォルダ"] button')].find((row) => row.textContent?.includes('01_商品写真'))), 'folderId'],
  ]
  it.each(filters)('%s で0件なら作る口を出さず「条件を外す」で全件に戻す', async (_name, apply, param) => {
    await render()
    await apply()
    expect(lastListRead().params.has(param)).toBe(true)
    expect(host.textContent).toContain('条件に合うものがありません')
    expect(host.textContent).not.toContain('まだメディアがありません')
    expect(button('最初のメディアを登録する')).toBeUndefined()
    await click(button('条件を外す'))
    const params = lastListRead().params
    for (const key of ['kind', 'folderId', 'query', 'unusedOnly', 'nearLimitOnly', 'archived']) expect(params.has(key), key).toBe(false)
    expect(host.textContent).toContain('秋の新商品.jpg')
  })
})

describe('フォルダの列（R37）', () => {
  it('選択中のアカウントのメディア用フォルダを読み、選ぶと folderId で一覧を絞る', async () => {
    await render()
    const folderRead = calls.find((call) => call.path === '/api/folders')!
    expect(folderRead.params.get('kind')).toBe('media')
    expect(folderRead.params.get('account_id')).toBe('account-a')
    await click([...host.querySelectorAll('nav[aria-label="フォルダ"] button')].find((row) => row.textContent?.includes('01_商品写真')))
    expect(lastListRead().params.get('folderId')).toBe('mf-photo')
  })

  it('管理者はフォルダの「…」から消せる。消す前に中身は未分類へ移ると確かめ、削除のあとに一覧を読み直す', async () => {
    await render()
    const panel = host.querySelector('[data-template-region="folders"]')!
    await click(panel.querySelector('button[aria-label="フォルダ「01_商品写真」の操作"]'))
    expect(menuItems()).toContain('名前を変える')
    await click([...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent?.trim() === '消す'))
    expect(document.body.textContent).toContain('中のメディア 1 件は消えずに「未分類」へ移ります')
    const listReads = calls.filter((call) => call.path === '/api/media').length
    await click(button('削除する'))
    const removed = calls.find((call) => call.method === 'DELETE')!
    expect(removed.path).toBe('/api/folders/mf-photo')
    expect(removed.params.get('account_id')).toBe('account-a')
    expect(calls.filter((call) => call.path === '/api/media').length).toBeGreaterThan(listReads)
  })

  it('閲覧のみにはフォルダの「…」を残し、変更を理由付きで拒否する', async () => {
    fixture.role = 'staff'
    await render()
    await expectLockedFolderMenu(host.querySelector('button[aria-label="フォルダ「01_商品写真」の操作"]'))
    expect(host.textContent).toContain('01_商品写真')
  })
})
