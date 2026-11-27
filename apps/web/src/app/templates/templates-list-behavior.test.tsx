// @vitest-environment happy-dom
/*
 * テンプレート一覧（W7LBc）を本物の画面で開き、押して確かめる。
 *
 * 種類のタブ・状態の板・閲覧のみ・狭い幅・削除の確認・詳細パネル・フォルダの操作・
 * 種類と数の書き方・読み込みの失敗と読み直しを、画面に出たものと API の呼び方で見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  role: 'owner',
  narrow: false,
  templatesList: vi.fn(),
  templatesDelete: vi.fn(),
  foldersList: vi.fn(),
  assetsList: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => fixture.narrow }))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message = '') { super(message) }
  }
  return {
    ApiError,
    api: {
      staff: { me: async () => ({ success: true, data: { role: fixture.role } }) },
      templates: {
        list: fixture.templatesList,
        get: (id: string) => Promise.resolve({
          success: true,
          data: {
            id, name: '来店お礼', category: 'general', messageType: 'text', messageContent: 'ご来店ありがとうございました。',
            folderId: null, question: null, questionStatus: 'published', usageCount: 0, tapCount: 0,
            usedBy: { autoReplies: [], automations: [], scenarioSteps: [], reminderSteps: [], richMenuAreas: [], trackedLinks: [], broadcasts: [] },
            hasDraft: false, publishedVersion: 1, publishedAt: '2026-09-01T00:00:00.000Z', draftRevision: 0,
            carouselActions: null, carouselTapLimitMode: 'none', carouselTapLimitText: null,
            createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
          },
        }),
        usages: () => Promise.resolve({ success: true, data: { broadcasts: [], autoReplies: [], scenarioSteps: [] } }),
        update: vi.fn(() => Promise.resolve({ success: true, data: {} })),
        delete: fixture.templatesDelete,
      },
      broadcastMessageAssets: {
        folders: { list: async () => ({ success: true, data: [] }) },
        list: fixture.assetsList,
        counts: () => Promise.resolve({ success: true, data: { card_message: 0, rich_message: 0, coupon: 0, research: 0 } }),
      },
      folders: {
        list: fixture.foldersList,
        swapOrder: vi.fn(() => Promise.resolve({ success: true })),
        delete: vi.fn(() => Promise.resolve({ success: true, data: null })),
        update: vi.fn(() => Promise.resolve({ success: true, data: {} })),
        create: vi.fn(() => Promise.resolve({ success: true, data: {} })),
      },
    },
  }
})

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/templates',
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))

import TemplatesPage from './page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { flushListUrlState } from '@/components/shared/list-url-state'
import { ApiError } from '@/lib/api'

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'general', messageType: 'text', messageContent: `${name}の本文`, folderId: null,
  question: null, questionStatus: 'published', usageCount: 0, tapCount: 0,
  monthlySendCount: 3, totalSendCount: 12, hasDraft: false, publishedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
})
const folder = (id: string, name: string, displayOrder: number, itemCount: number) => ({
  id, kind: 'template', name, parentId: null, displayOrder, color: null, itemCount,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
})

beforeEach(() => {
  flushListUrlState()
  window.history.replaceState(null, '', '/templates')
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'lh_staff_role' ? fixture.role : null),
    setItem: () => {},
    removeItem: () => {},
  })
  fixture.role = 'owner'
  fixture.narrow = false
  fixture.templatesList.mockReset()
  fixture.templatesList.mockResolvedValue({ success: true, data: [row('tpl-1', '来店お礼')] })
  fixture.templatesDelete.mockReset()
  fixture.templatesDelete.mockResolvedValue({ success: true, data: null })
  fixture.foldersList.mockReset()
  fixture.foldersList.mockResolvedValue({ success: true, data: [], unfiledCount: 1 })
  fixture.assetsList.mockReset()
  fixture.assetsList.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  clearToastsForTest()
  flushListUrlState()
  vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

async function renderList() {
  const view = render(<><TemplatesPage /><ToastHost /></>)
  await settle()
  return view
}

const rowNames = () => [...document.querySelectorAll('tbody tr[data-row-id]')].map((tr) => tr.getAttribute('data-row-id'))

async function openRowMenuAndDelete(name: string) {
  fireEvent.click(screen.getAllByRole('button', { name: `テンプレート「${name}」の操作` })[0])
  fireEvent.click((await screen.findAllByRole('menuitem', { name: '削除する' }))[0])
  return screen.findByRole('alertdialog')
}

describe('種類のタブ', () => {
  it('種類をURLに残し、読み直しと戻る操作で同じタブを開く', async () => {
    const view = await renderList()
    fireEvent.click(screen.getByRole('tab', { name: /^質問/ }))
    flushListUrlState()
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('question')
    view.unmount()
    await renderList()
    expect(screen.getByRole('tab', { name: /^質問/ }).getAttribute('aria-selected')).toBe('true')
    act(() => { window.history.replaceState(null, '', '/templates?tab=rich_video'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('tab', { name: /^リッチビデオ/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('素材の種類を開き直し、不明な種類はメッセージに戻す', async () => {
    window.history.replaceState(null, '', '/templates?tab=coupon')
    await renderList()
    expect(screen.getByRole('tab', { name: /^クーポン/ }).getAttribute('aria-selected')).toBe('true')
    expect(fixture.assetsList).toHaveBeenCalledWith({ accountId: 'account-a', kind: 'coupon' })
    act(() => { window.history.replaceState(null, '', '/templates?tab=unknown'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('tab', { name: /^メッセージ/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('カルーセル・リッチメッセージ・クーポン・リサーチのタブは、その種類の中身を選んでいるアカウントで読む', async () => {
    await renderList()
    const kinds: Array<[string, string]> = [['カルーセル', 'card_message'], ['リッチメッセージ', 'rich_message'], ['クーポン', 'coupon'], ['リサーチ', 'research']]
    for (const [label, kind] of kinds) {
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}`) })) })
      await settle()
      expect(fixture.assetsList).toHaveBeenLastCalledWith({ accountId: 'account-a', kind })
    }
  })
})

describe('状態の板と見るための印', () => {
  it('読込中・読み込めない・まだ無い、のどれでも状態の板（susGP）を出す', async () => {
    fixture.templatesList.mockReturnValue(new Promise(() => {}))
    const loading = await renderList()
    expect(document.querySelector('[data-design-node="susGP"]')?.getAttribute('aria-label')).toBe('読み込み中')
    loading.unmount()

    fixture.templatesList.mockResolvedValue({ success: false, error: 'unavailable' })
    const failed = await renderList()
    expect(document.querySelector('[data-design-node="susGP"]')?.textContent).toContain('テンプレートを読み込めませんでした')
    failed.unmount()

    fixture.templatesList.mockResolvedValue({ success: true, data: [] })
    await renderList()
    expect(document.querySelector('[data-design-node="susGP"]')?.textContent).toContain('まだメッセージのテンプレートがありません')
  })

  it('見るだけの人には閲覧のみの帯（hEDTK）を出し、変えられる人には出さない', async () => {
    fixture.role = 'staff'
    const staff = await renderList()
    expect(document.querySelector('[data-design-node="hEDTK"]')?.textContent).toContain('この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。')
    staff.unmount()

    fixture.role = 'owner'
    await renderList()
    expect(document.querySelector('[data-design-node="hEDTK"]')).toBeNull()
  })

  it('狭い幅では一覧の板が L7zA7C、広い幅では v19Ivv になる', async () => {
    fixture.narrow = true
    const narrow = await renderList()
    expect(document.querySelector('[data-design-node="L7zA7C"]')).not.toBeNull()
    expect(document.querySelector('[data-design-node="v19Ivv"]')).toBeNull()
    narrow.unmount()

    fixture.narrow = false
    await renderList()
    expect(document.querySelector('[data-design-node="v19Ivv"]')).not.toBeNull()
    expect(document.querySelector('[data-design-node="L7zA7C"]')).toBeNull()
  })
})

describe('読み込みの失敗と読み直し', () => {
  it('権限が無いときは「見る権限がありません」、通信の失敗は「読み込めませんでした」と言い分ける', async () => {
    fixture.templatesList.mockRejectedValue(new ApiError(403, 'forbidden'))
    const forbidden = await renderList()
    expect(screen.getByText('見る権限がありません')).toBeTruthy()
    expect(screen.queryByText('テンプレートを読み込めませんでした')).toBeNull()
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
    forbidden.unmount()

    fixture.templatesList.mockRejectedValue(new Error('network'))
    await renderList()
    expect(screen.getByText('テンプレートを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('見る権限がありません')).toBeNull()
  })

  it('読み込めなかったら「もう一度読み込む」で読み直し、読めたら行が出る', async () => {
    fixture.templatesList.mockResolvedValueOnce({ success: false, error: 'unavailable' })
    await renderList()
    const before = fixture.templatesList.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
    await settle()
    expect(fixture.templatesList.mock.calls.length).toBe(before + 1)
    expect(rowNames()).toEqual(['tpl-1'])
  })

  it('まだ1件も無いときと、絞り込んで0件のときを言い分ける', async () => {
    fixture.templatesList.mockResolvedValue({ success: true, data: [] })
    const empty = await renderList()
    expect(screen.getByText('まだメッセージのテンプレートがありません')).toBeTruthy()
    empty.unmount()

    fixture.templatesList.mockResolvedValue({ success: true, data: [row('tpl-1', '来店お礼')] })
    await renderList()
    await act(async () => { fireEvent.change(screen.getByLabelText('テンプレートを検索'), { target: { value: '見つからない言葉' } }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) })
    expect(screen.getByText('条件に合うものがありません')).toBeTruthy()
    expect(screen.queryByText('まだメッセージのテンプレートがありません')).toBeNull()
    expect(rowNames()).toEqual([])
  })

  it('読み込み中と読み込めないあいだは「テンプレートを作る」を押せず、理由を title で読める', async () => {
    let finish!: (value: unknown) => void
    fixture.templatesList.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await renderList()
    const create = () => screen.getAllByRole('button', { name: /メッセージを作る/ })[0] as HTMLButtonElement
    expect(create().disabled).toBe(true)
    expect(create().title).toBe('読み込んでいます')
    await act(async () => { finish({ success: false, error: 'unavailable' }) })
    await settle()
    expect(create().disabled).toBe(true)
    expect(create().title).toBe('読み込めませんでした。読み直してからお試しください。')
    fixture.templatesList.mockResolvedValue({ success: true, data: [row('tpl-1', '来店お礼')] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
    await settle()
    expect(screen.getAllByRole('link', { name: 'メッセージを作る' })[0].getAttribute('href')).toBe('/templates/edit')
  })
})

describe('種類と数の書き方', () => {
  it('知らない種類は内部の名前を出さず「その他」、カード型・カルーセルは運用の言葉で出す', async () => {
    fixture.narrow = true
    fixture.templatesList.mockResolvedValue({
      success: true,
      data: [
        row('tpl-sticker', 'スタンプのお礼', { messageType: 'sticker', messageContent: '{"packageId":"1","stickerId":"2"}' }),
        row('tpl-flex', 'カードのご案内', { messageType: 'flex', messageContent: '{"type":"bubble"}' }),
        row('tpl-carousel', '横にめくるご案内', { messageType: 'carousel', messageContent: '[]' }),
      ],
    })
    await renderList()
    expect(screen.getByLabelText('種類：その他')).toBeTruthy()
    expect(screen.getByLabelText('種類：カード型')).toBeTruthy()
    expect(screen.getByLabelText('種類：カルーセル')).toBeTruthy()
    expect(document.querySelector('tbody')?.textContent).not.toMatch(/sticker|Flex|Carousel/)
  })

  it('使っている数が取れていないものを 0 と書かず、0 は「なし」、数があれば「N か所」と書き分ける', async () => {
    fixture.templatesList.mockResolvedValue({
      success: true,
      data: [
        row('tpl-unknown', '数えられない', { usageCount: undefined }),
        row('tpl-zero', '使っていない', { usageCount: 0 }),
        row('tpl-used', '使っている', { usageCount: 2 }),
      ],
    })
    await renderList()
    const cells = (id: string) => document.querySelector(`tr[data-row-id="${id}"]`)!.textContent
    expect(cells('tpl-unknown')).toContain('使っている所を確認できません')
    expect(cells('tpl-unknown')).not.toContain('0か所')
    expect(cells('tpl-zero')).toContain('なし')
    expect(cells('tpl-used')).toContain('2か所')
  })

  it('今月送った数を出し、累計は title で読め、取れていない数を 0 にしない', async () => {
    fixture.templatesList.mockResolvedValue({
      success: true,
      data: [
        row('tpl-sent', '送ったもの', { monthlySendCount: 1200, totalSendCount: 3400 }),
        row('tpl-unknown', '数が無いもの', { monthlySendCount: undefined, totalSendCount: undefined }),
      ],
    })
    await renderList()
    expect(screen.getByText('今月送った数', { selector: 'th' })).toBeTruthy()
    const sent = screen.getByText('1,200 通')
    expect(sent.getAttribute('title')).toBe('累計 3,400 通')
    const unknown = document.querySelector('tr[data-row-id="tpl-unknown"]')!
    expect(unknown.textContent).toContain('—')
    expect(unknown.textContent).not.toMatch(/通/)
  })

  it('絞り込みの札は「複数通」「差し込みあり」の運用の言葉で、押すとその中身だけに絞る', async () => {
    fixture.templatesList.mockResolvedValue({
      success: true,
      data: [
        row('tpl-single', '1通だけ', { messageContent: 'こんにちは' }),
        row('tpl-multi', '2通に分かれる', { messageBubbles: [{ id: '1', type: 'text', content: { text: '1通目' } }, { id: '2', type: 'text', content: { text: '2通目' } }] }),
        row('tpl-var', '名前を入れる', { messageContent: '{{name}}さん、こんにちは' }),
      ],
    })
    await renderList()
    const chips = within(screen.getByRole('group', { name: '中身で絞り込む' }))
    await act(async () => { fireEvent.click(chips.getByRole('button', { name: '複数通', exact: true })) })
    await settle()
    expect(chips.getByRole('button', { name: '複数通', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(rowNames()).toEqual(['tpl-multi'])
    await act(async () => { fireEvent.click(within(chips.getByRole('group', { name: 'メッセージの数' })).getByRole('button', { name: 'すべて', exact: true })) })
    await act(async () => { fireEvent.click(chips.getByRole('button', { name: '差し込みあり', exact: true })) })
    await settle()
    expect(rowNames()).toEqual(['tpl-var'])
  })
})

describe('削除の確認', () => {
  it('削除を待っているあいだは二度押しも Esc も受け付けず、送るのは1回だけ', async () => {
    let finish!: (value: unknown) => void
    fixture.templatesDelete.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await renderList()
    const dialog = await openRowMenuAndDelete('来店お礼')
    expect(dialog.textContent).toContain('来店お礼')
    const remove = within(dialog).getByRole('button', { name: '削除する' })
    await act(async () => { fireEvent.click(remove); fireEvent.click(remove) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(fixture.templatesDelete).toHaveBeenCalledTimes(1)
    expect(fixture.templatesDelete).toHaveBeenCalledWith('tpl-1')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    await act(async () => { finish({ success: true, data: null }) })
    await settle()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('削除が断られたら窓を閉じず、生の理由ではなく運用の言葉で窓の中に出し、もう一度押せる', async () => {
    fixture.templatesDelete.mockResolvedValue({ success: false, error: 'D1_ERROR: constraint failed' })
    await renderList()
    const dialog = await openRowMenuAndDelete('来店お礼')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '削除する' })) })
    await settle()
    const still = screen.getByRole('alertdialog')
    expect(still.textContent).toContain('このテンプレートを削除できませんでした。状態を読み直してから、もう一度お試しください。')
    expect(still.textContent).not.toContain('D1_ERROR')
    expect((within(still).getByRole('button', { name: '削除する' }) as HTMLButtonElement).disabled).toBe(false)
    expect(rowNames()).toEqual(['tpl-1'])
  })

  it('使っているものは、何か所で使われていて先に差し替えることを窓で言う', async () => {
    fixture.templatesList.mockResolvedValue({ success: true, data: [row('tpl-1', '来店お礼', { usageCount: 3 })] })
    await renderList()
    fireEvent.click(screen.getAllByRole('button', { name: 'テンプレート「来店お礼」の操作' })[0])
    fireEvent.click((await screen.findAllByRole('menuitem', { name: '削除する' }))[0])
    await settle()
    expect(document.body.textContent).toContain('3 か所で使われています。消すと、その配信や自動応答が送れなくなるためです。先に別のテンプレートへ差し替えてください。')
    expect(fixture.templatesDelete).not.toHaveBeenCalled()
  })
})

describe('詳細パネル', () => {
  it('行を開いた詳細パネルは、名前の付いた「閉じる」ボタンで閉じる', async () => {
    await renderList()
    fireEvent.keyDown(within(screen.getByRole('table')).getByText('来店お礼').closest('tr')!, { key: 'Enter' })
    await settle()
    const panel = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '閉じる' })) })
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('フォルダ', () => {
  beforeEach(() => {
    fixture.foldersList.mockResolvedValue({
      success: true,
      data: [folder('f-first', '予約', 0, 1), folder('f-middle', '来店', 1, 1), folder('f-last', '発送', 2, 0)],
      unfiledCount: 1,
    })
    fixture.templatesList.mockResolvedValue({
      success: true,
      data: [
        row('tpl-booking', '予約の受付', { folderId: 'f-first' }),
        row('tpl-visit', '来店のお礼', { folderId: 'f-middle' }),
        row('tpl-loose', 'どこにも無い', { folderId: null }),
      ],
    })
  })

  const pickFolder = async (title: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-part="folder-row"]')].find((b) => b.getAttribute('title') === title)!
    await act(async () => { fireEvent.click(button) })
    await settle()
  }
  const folderMenu = async (name: string) => {
    fireEvent.click(screen.getAllByRole('button', { name: `フォルダ「${name}」の操作` })[0])
    const menu = (await screen.findAllByRole('menu', { name: `フォルダ「${name}」の操作` }))[0]
    return within(menu).getAllByRole('menuitem').map((item) => item.textContent)
  }

  it('フォルダを選ぶと、その中のものだけ（未分類は置き場の無いものだけ）に絞る', async () => {
    await renderList()
    await pickFolder('来店')
    expect(rowNames()).toEqual(['tpl-visit'])
    await pickFolder('未分類')
    expect(rowNames()).toEqual(['tpl-loose'])
    await pickFolder('すべて')
    expect(rowNames()).toEqual(['tpl-booking', 'tpl-visit', 'tpl-loose'])
  })

  it('フォルダの操作は名前・色・並べ替え・消す。端の行には動けない向きの並べ替えを出さない', async () => {
    await renderList()
    expect(await folderMenu('予約')).toEqual(['名前を変更する', '色を変更する', '並べ替える（下へ）', '消す'])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await folderMenu('来店')).toEqual(['名前を変更する', '色を変更する', '並べ替える（上へ）', '並べ替える（下へ）', '消す'])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await folderMenu('発送')).toEqual(['名前を変更する', '色を変更する', '並べ替える（上へ）', '消す'])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await folderMenu('すべて')).toContain('フォルダを追加')
  })

  it('フォルダを消す前に、中身は未分類に残ることと今入っている数を言う', async () => {
    await renderList()
    await folderMenu('予約')
    await act(async () => { fireEvent.click(screen.getAllByRole('menuitem', { name: '消す' })[0]) })
    await settle()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('削除しても、中のテンプレートは未分類に残ります。')
    expect(dialog.textContent).toContain('いまこのフォルダに入っているのは1')
  })
})
