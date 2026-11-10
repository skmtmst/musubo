import { getPageAction, queryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/**
 * 回答フォームの編集（★V8・src/v8/form-edit）の動き。
 * V8 のテーマで出し、タブ・ページの指定・競合の帯・公開の確かめ・押せないボタンが無いことを見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout, type FormLayout } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const navigation = vi.hoisted(() => ({ query: '', push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  usePathname: () => '/form-submissions/edit',
  useSearchParams: () => new URLSearchParams(navigation.query),
  useParams: () => ({}),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a>,
}))
const account = vi.hoisted(() => ({ id: 'acc-1' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, name: 'テスト店', liffId: 'liff-1' }, accounts: [], loading: false }),
}))
const chromeTitle = vi.hoisted(() => vi.fn())
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: chromeTitle, usePageCrumbs: () => {}, usePageChrome: () => ({ title: '' }) }))

const forcedRole = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('@/lib/staff-role', async original => {
  const actual = await original<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => { const role = actual.useStaffRole(); return forcedRole.value ?? role } }
})
const staffMe = vi.hoisted(() => vi.fn())
const formsGet = vi.hoisted(() => vi.fn())
const formsUpdate = vi.hoisted(() => vi.fn())
const formsCreateDraft = vi.hoisted(() => vi.fn())
const formsPublish = vi.hoisted(() => vi.fn())
const menuStaff = vi.hoisted(()=>vi.fn(async()=>({staff:[]})))
const emptyList = vi.hoisted(() => async () => ({ success: true, data: [] as never[] }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: vi.fn(async () => ({ success: true, data: [{ id: 'tag-1', name: 'アンケート回答' }] })),
    bookingApi: {
      ...actual.bookingApi,
      listMenus: vi.fn(async () => ({ menus: [{ id: 'bm-1', name: 'トリミング（小型犬）', duration_minutes: 60, is_active: 1 }] })),
      listMenuStaff: menuStaff,
    },
    api: {
      ...actual.api,
      forms: { ...actual.api.forms, get: formsGet, update: formsUpdate, publish: formsPublish, createDraft: formsCreateDraft },
      // 下書きの自動保存は閲覧のみの人には動かさないため、役割を読む（通信させない）。
      staff: { ...actual.api.staff, me: staffMe },
      friendFields: { ...actual.api.friendFields, list: emptyList },
      scenarios: { ...actual.api.scenarios, list: emptyList },
      reminders: { ...actual.api.reminders, list: emptyList },
      templates: { ...actual.api.templates, list: emptyList },
    },
  }
})

import FormEditPage from '@/app/form-submissions/edit/page'
import FormEditV8 from './edit'
import { EMPTY_REFS } from '@/components/forms/form-refs'
import type { FormEditHost, FormHostContent } from './host'
import { readCreatedFormDraft } from '@/lib/form-draft-session'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { ApiError,api } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const layout: FormLayout = (() => {
  const l = emptyLayout()
  l.sections = [
    { id: 's1', name: '来店について', blocks: [
      { id: 'h1', kind: 'heading', text: '来店アンケート', level: 1 },
      { id: 'q1', kind: 'input', type: 'radio', name: 'purpose', label: '今日のご来店の目的は？', required: true, choiceMode: 'tag', choices: [{ id: 'c1', label: 'トリミング' }, { id: 'c2', label: 'ご相談' }] },
    ] },
    { id: 's2', name: '次回について', blocks: [
      { id: 'q2', kind: 'input', type: 'booking', name: 'next', label: '次回のご希望の日時を選んでください', booking: { menuId: 'bm-1', staffId: null, daysAhead: 14 } },
    ] },
  ]
  l.options = { ...l.options, afterActions: [{ kind: 'send_text', text: 'ご回答ありがとうございます' }] }
  return l
})()

const formData = {
  id: 'form-1', name: '来店アンケート', description: '', isActive: true, submitCount: 1284, onSubmitTagId: null,
  layout, ogTitle: null, ogDescription: null, ogImageUrl: null, contentRevision: 7, publishedVersionId: 'v3', publishedContentRevision: 6,
}

let host: HTMLDivElement
let root: Root
const render = async (query: string) => {
  navigation.query = query
  act(() => { root.render(<><FormEditPage /><ToastHost /></>) })
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  account.id = 'acc-1'
  forcedRole.value = null
  staffMe.mockReset().mockResolvedValue({ success: true, data: { role: 'owner' } })
  document.documentElement.dataset.theme = 'v8'
  formsGet.mockImplementation(async () => ({ success: true, data: structuredClone(formData) }))
  formsUpdate.mockImplementation(async () => ({ success: true, data: { id: 'form-1', contentRevision: 8, updatedAt: '' } }))
  formsCreateDraft.mockReset().mockResolvedValue({ success: true, data: { id: 'form-created', isActive: false, contentRevision: 1 } })
  formsPublish.mockImplementation(async () => ({ success: true, data: { id: 'v4', versionNumber: 4, contentRevision: 8, publishedAt: '', replayed: false } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

describe('回答フォームの編集（V8）', () => {
  it('中身から名前を変え、タブを替えても同じ値を保存して読み直せる', async () => {
    await render('id=form-1')
    const input = screen.getByLabelText('フォーム名') as HTMLInputElement
    expect(input.value).toBe(formData.name)
    fireEvent.change(input, { target: { value: '秋のアンケート' } })
    expect(screen.getByRole('heading', { name: '秋のアンケート', exact: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    expect((screen.getByLabelText('フォーム名') as HTMLInputElement).value).toBe('秋のアンケート')
    fireEvent.click(screen.getByRole('tab', { name: '中身' }))
    expect((screen.getByLabelText('フォーム名') as HTMLInputElement).value).toBe('秋のアンケート')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledWith('form-1', 'acc-1', expect.objectContaining({ name: '秋のアンケート', expectedContentRevision: 7 })))
    await screen.findByText('下書きを保存しました')
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), name: '秋のアンケート', contentRevision: 8 } })
    act(() => root.unmount())
    root = createRoot(host)
    await render('id=form-1')
    expect((screen.getByLabelText('フォーム名') as HTMLInputElement).value).toBe('秋のアンケート')
  })

  it('中身の名前の入力と欄の理由を、保存が失敗しても残す', async () => {
    formsUpdate.mockRejectedValue(new ApiError(503, 'offline'))
    await render('id=form-1')
    const input = screen.getByLabelText('フォーム名') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(screen.getByRole('alert').textContent).toBe('フォーム名を入力してください')
    fireEvent.change(input, { target: { value: '保存したい名前' } })
    expect(screen.queryByText('フォーム名を入力してください')).toBeNull()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledOnce())
    expect(input.value).toBe('保存したい名前')
    expect(formsPublish).not.toHaveBeenCalled()
  })

  it('統括でも中身の名前を同じ保存口へ渡す', async () => {
    navigation.query = 'tab=basic'
    const onSave = vi.fn(async () => true)
    act(() => root.render(<FormEditV8 host={{ initial: { name: '店向けのひな形', description: '', layout: emptyLayout(), onSubmitTagId: '' }, refs: EMPTY_REFS, accountName: 'ひな形', backHref: '/hq/form-submissions', statusLine: '下書き', distributedLine: 'まだ配っていません', busy: false, onSave, onCancel: vi.fn() }} />))
    const input = await screen.findByLabelText('フォーム名')
    fireEvent.change(input, { target: { value: '季節のひな形' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: '季節のひな形' }), false))
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(formsGet).not.toHaveBeenCalled()
  })

  it('壊れたIDのリンクでも画面を落とさず、見つからない案内を出す', async () => {
    formsGet.mockRejectedValue(new ApiError(404, 'missing'))
    await render('id=bad.id')
    expect(await screen.findByText('このフォームは見つかりません')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '回答用URL' })).toBeNull()
  })

  it('回答用URLの表示とコピーは、一覧と削除の案内で使うLIFFの入口にそろう', async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await render('id=form-1')
      const region = within(screen.getByRole('region', { name: '回答用URL' }))
      const expected = 'https://liff.line.me/liff-1/?page=form&id=form-1'
      expect(region.getByText(expected).getAttribute('title')).toBe(expected)
      fireEvent.click(region.getByRole('button', { name: '回答用URLをコピー' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected))
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('未公開の下書きは、回答用URLのそばで公開すると開けることを知らせる', async () => {
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), isActive: false, publishedVersionId: null, publishedContentRevision: null } })
    await render('id=form-1')
    expect(within(screen.getByRole('region', { name: '回答用URL' })).getByText('公開すると開けます。公開前は回答を受け付けません。')).toBeTruthy()
  })

  it('公開した版がある受付停止中のフォームを、未公開の下書きとは案内しない', async () => {
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), isActive: false } })
    await render('id=form-1')
    const region = within(screen.getByRole('region', { name: '回答用URL' }))
    expect(region.queryByText('公開すると開けます。公開前は回答を受け付けません。')).toBeNull()
    expect(region.getByRole('button', { name: '回答用URLをコピー' })).toBeTruthy()
  })

  it('編集中の名前を電話の見本の題へ渡す', async () => {
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), layout: { ...structuredClone(layout), options: { ...layout.options, pageTitle: '' } } } })
    await render('id=form-1&tab=appearance')
    const phone = host.querySelector('[data-liff-phone-frame]') as HTMLElement
    expect(within(phone).getByTitle(formData.name).textContent).toBe(formData.name)
    fireEvent.change(screen.getByLabelText('フォーム名'), { target: { value: '秋の感想を聞くフォーム' } })
    expect(within(phone).getByTitle('秋の感想を聞くフォーム').textContent).toBe('秋の感想を聞くフォーム')
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('フォーム名の読み込み中は編集の題を出し、読めた名前を帯と本文へ渡す', async () => {
    let resolveForm!: (value: unknown) => void
    formsGet.mockImplementation(() => new Promise(resolve => { resolveForm = resolve }))
    await render('id=form-1')
    expect(screen.getByRole('heading', { name: '回答フォーム編集', exact: true })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'フォーム名未設定', exact: true })).toBeNull()
    expect(chromeTitle).toHaveBeenLastCalledWith('回答フォーム編集')
    await act(async () => { resolveForm({ success: true, data: structuredClone(formData) }) })
    expect(await screen.findByRole('heading', { name: formData.name, exact: true })).toBeTruthy()
    expect(chromeTitle).toHaveBeenLastCalledWith(formData.name)
  })

  it('取得済みで名前が空なら、帯と本文の両方で未設定と分かる', async () => {
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), name: '' } })
    await render('id=form-1')
    expect(await screen.findByRole('heading', { name: 'フォーム名未設定', exact: true })).toBeTruthy()
    expect(chromeTitle).toHaveBeenLastCalledWith('フォーム名未設定')
  })

  it('同じ編集画面でIDを替えたら、次の取得中に前の名前を残さない', async () => {
    await render('id=form-1')
    await screen.findByRole('heading', { name: formData.name, exact: true })
    let resolveForm!: (value: unknown) => void
    formsGet.mockImplementation(() => new Promise(resolve => { resolveForm = resolve }))
    await render('id=form-2')
    expect(screen.getByRole('heading', { name: '回答フォーム編集', exact: true })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: formData.name, exact: true })).toBeNull()
    await act(async () => { resolveForm({ success: true, data: { ...structuredClone(formData), id: 'form-2', name: '次のアンケート' } }) })
    expect(await screen.findByRole('heading', { name: '次のアンケート', exact: true })).toBeTruthy()
    expect(chromeTitle).toHaveBeenLastCalledWith('次のアンケート')
  })

  it('店舗を替えたら、同じIDでも前の店舗の名前を残さない', async () => {
    await render('id=form-1')
    await screen.findByRole('heading', { name: formData.name, exact: true })
    let resolveForm!: (value: unknown) => void
    formsGet.mockImplementation(() => new Promise(resolve => { resolveForm = resolve }))
    account.id = 'acc-2'
    await render('id=form-1')
    expect(screen.getByRole('heading', { name: '回答フォーム編集', exact: true })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: formData.name, exact: true })).toBeNull()
    expect(formsGet).toHaveBeenLastCalledWith('form-1', 'acc-2')
    await act(async () => { resolveForm({ success: true, data: { ...structuredClone(formData), name: '二号店のアンケート' } }) })
    expect(await screen.findByRole('heading', { name: '二号店のアンケート', exact: true })).toBeTruthy()
  })

  it('店舗を替えても元の店の保存と公開を完了し、新しい入力と画面を保つ', async () => {
    await render('id=form-1')
    let finish!: (value: unknown) => void
    formsUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'この版を公開' }))
    const dialog = await screen.findByRole('dialog', { name: 'この版を公開する' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'この版を公開' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledTimes(1))
    account.id = 'acc-2'
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), name: '二号店のアンケート' } })
    await render('id=form-1')
    await screen.findByRole('heading', { name: '二号店のアンケート', exact: true })
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    const input = screen.getByDisplayValue('二号店のアンケート')
    fireEvent.change(input, { target: { value: '二号店の入力途中' } })
    await act(async () => { finish({ success: true, data: { id: 'form-1', contentRevision: 8, updatedAt: '' } }) })
    expect(formsPublish).toHaveBeenCalledExactlyOnceWith('form-1', 'acc-1', 8)
    expect(document.body.textContent).not.toContain('この版を公開しました')
    expect(screen.getByDisplayValue('二号店の入力途中')).toBe(input)
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledTimes(2))
    expect(formsUpdate.mock.calls.map(call => call[1])).toEqual(['acc-1', 'acc-2'])
    await screen.findByText('下書きを保存しました')
  })

  it('対象のIDを替えた後も旧保存の競合を元の対象で確認し、今の画面には表示しない', async () => {
    await render('id=form-1')
    let fail!: (error: Error) => void
    formsUpdate.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledTimes(1))
    formsGet.mockResolvedValue({ success: true, data: { ...structuredClone(formData), id: 'form-2', name: '次のフォーム' } })
    await render('id=form-2')
    await screen.findByRole('heading', { name: '次のフォーム', exact: true })
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    const reads = formsGet.mock.calls.length
    await act(async () => { fail(new ApiError(409, 'conflict', 'VERSION_CONFLICT', { updatedAt: '' })) })
    expect(formsGet).toHaveBeenCalledTimes(reads + 1)
    expect(formsGet).toHaveBeenLastCalledWith('form-1', 'acc-1')
    expect(formsPublish).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('次のフォーム')).toBeTruthy()
    expect(document.body.textContent).not.toContain('ほかの人が')
    expect(document.body.textContent).not.toContain('下書きを保存しました')
  })

  it('V8 では src/v8 の画面が出て、最初のページの最初の質問の設定が開いている', async () => {
    await render('id=form-1')
    expect(await screen.findByRole('tab', { name: '中身' })).toBeTruthy()
    expect(document.querySelector('[data-page-template="create"]')).toBeTruthy()
    expect(screen.getByText('ページ1 のブロック')).toBeTruthy()
    // 開いている設定（質問文の欄）に質問の文が入っている
    expect(screen.getByDisplayValue('今日のご来店の目的は？')).toBeTruthy()
    expect(screen.getByDisplayValue('今日のご来店の目的は？').closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
    expect(screen.getByText('下書き・公開中と違います')).toBeTruthy()
  })

  it.each(['staff', 'owner', 'admin'])('役割の読み込み後、保存・公開は権限で隠す（%s）', async (role) => {
    staffMe.mockResolvedValue({ success: true, data: { role } })
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    for (const name of ['下書きを保存', 'この版を公開']) {
      expect(queryPageAction({ name }) !== null).toBe(role !== 'staff')
    }
    if (role === 'staff') expect(screen.getByText('閲覧のみで見ています。変える操作は管理者に頼んでください。')).toBeTruthy()
  })

  it('役割を確認中は保存・公開を出さず、staff と分かったあとも出さない', async () => {
    let resolveRole!: (response: { success: true; data: { role: string } }) => void
    staffMe.mockImplementation(() => new Promise((resolve) => { resolveRole = resolve }))
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    const expectHidden = () => {
      for (const name of ['下書きを保存', 'この版を公開', '比べてから保存']) {
        expect(screen.queryByRole('button', { name })).toBeNull()
      }
    }
    expectHidden()
    await act(async () => { resolveRole({ success: true, data: { role: 'staff' } }) })
    expectHidden()
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(formsPublish).not.toHaveBeenCalled()
  })

  it('閲覧のみの3タブは内容を読めるが、追加・変更・試しURL作成は出さない', async () => {
    staffMe.mockResolvedValue({ success: true, data: { role: 'staff' } })
    await render('id=form-1')
    expect(within(host.querySelector('[data-fe-root]') as HTMLElement).getByText('今日のご来店の目的は？')).toBeTruthy()
    for (const name of ['ページを足す', '公開前に試す（試しのURLを作る）']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(host.querySelector('[data-fe-root] input, [data-fe-root] textarea')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '答え終わったあと' }))
    expect(screen.getByText('「ご回答ありがとうございます」')).toBeTruthy()
    expect(host.querySelector('[data-fe-root] input, [data-fe-root] textarea')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    expect(screen.getAllByText('来店アンケート').length).toBeGreaterThan(0)
    expect(host.querySelector('[data-fe-root] input, [data-fe-root] textarea')).toBeNull()
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('19: 書いていない覚え書き・背景の画像は「未設定」と出す', async () => {
    staffMe.mockResolvedValue({ success: true, data: { role: 'staff' } })
    await render('id=form-1')
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    const card = screen.getByRole('heading', { name: '受付と見た目' }).closest('section') ?? host
    const rowOf = (label: string) => Array.from(card.querySelectorAll('dt'))
      .find((term) => term.textContent === label)?.parentElement?.textContent ?? ''
    expect(rowOf('覚え書き')).toContain('未設定')
    expect(rowOf('背景の画像')).toContain('未設定')
  })

  it('削除されたメニューは選び直す案内を出して入力を残す', async () => {
    formsUpdate.mockRejectedValueOnce(new ApiError(409, 'コースが見つかりません', 'restaurant_course_unavailable'))
    await render('id=form-1')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    expect(await screen.findByText(/メニューを選び直してください/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '比べてから保存' })).toBeNull()
  })

  it('競合が残っていてもstaffに変わると保存と比較の入口を隠す', async () => {
    formsUpdate.mockRejectedValue(new ApiError(409, 'conflict', 'VERSION_CONFLICT', { updatedAt: '' }))
    formsGet.mockResolvedValueOnce({ success: true, data: structuredClone(formData) })
      .mockResolvedValue({ success: true, data: { ...structuredClone(formData), name: '別の人の保存' } })
    await render('id=form-1')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByRole('button', { name: '比べてから保存' })
    forcedRole.value = 'staff'
    await render('id=form-1')
    for (const name of ['下書きを保存', 'この版を公開', '比べてから保存', '違いを比べる']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('役割の取得が失敗しても保存・公開を出さない', async () => {
    staffMe.mockRejectedValue(new Error('役割を読めない'))
    await render('id=form-1')
    expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'この版を公開' })).toBeNull()
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('押せない（disabled の）ボタンを置いていない', async () => {
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    const disabled = [...host.querySelectorAll('button')].filter((b) => b.disabled).map((b) => b.textContent || b.getAttribute('aria-label'))
    expect(disabled).toEqual([])
  })

  it('?page=2 で2ページ目を開き、予約を入れるブロックの設定が出る', async () => {
    await render('id=form-1&page=2')
    expect(await screen.findByText('ページ2 のブロック')).toBeTruthy()
    expect(screen.getByDisplayValue('次回のご希望の日時を選んでください')).toBeTruthy()
    expect(screen.getByText('予約メニューへ').closest('a')?.getAttribute('href')).toBe('/booking/menus')
  })

  it('「答え終わったあと」のタブでは右のスマホにお礼の画面を出し、中身のタブでは質問に戻す', async () => {
    /* お礼の文を空にし、実画面（LIFF）と同じ予備文が出ることを確かめる */
    formsGet.mockImplementation(async () => ({ success: true, data: { ...structuredClone(formData), layout: { ...structuredClone(layout), options: { ...layout.options, thanksText: '' } } } }))
    await render('id=form-1&tab=after')
    expect(await screen.findByText('答え終わったら行うこと')).toBeTruthy()
    expect(screen.getByText('ご回答ありがとうございました')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '中身' }))
    expect(await screen.findByText('ページ1 のブロック')).toBeTruthy()
    expect(screen.queryByText('ご回答ありがとうございました')).toBeNull()
    expect(screen.getAllByText('今日のご来店の目的は？').length).toBeGreaterThan(0)
  })

  it('?tab= で答え終わったあと・受付と見た目を開け、タブでも切り替わる', async () => {
    await render('id=form-1&tab=after')
    expect(await screen.findByText('答え終わったら行うこと')).toBeTruthy()
    expect(screen.getByText('「ご回答ありがとうございます」')).toBeTruthy()
    /* 種類と題で同じ言葉を2回言わない（種類「テキストを送る」＋題「本文」）。 */
    const row = screen.getByText('「ご回答ありがとうございます」').closest('[data-action-row]')
    expect(within(row as HTMLElement).getByText('テキストを送る')).toBeTruthy()
    expect(within(row as HTMLElement).getByRole('button', { name: '「ご回答ありがとうございます」' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '受付と見た目' }))
    /* 受付のきまりは1枚のカードにまとまり、つづきの見出しは無い（91）。 */
    expect(await screen.findByRole('heading', { name: '受付のきまり' })).toBeTruthy()
    expect(screen.queryByText('受付のきまり（つづき）')).toBeNull()
    expect(screen.getByText('前回の答えを最初から入れておく')).toBeTruthy()
    expect(screen.getByDisplayValue('来店アンケート')).toBeTruthy()
  })

  it('2ページ目の質問文が空のまま保存すると、そのページとブロックを開いて質問文の欄へ移り、中身のタブに赤い印を付ける', async () => {
    const broken = structuredClone(formData)
    ;(broken.layout.sections[1].blocks[0] as { label: string }).label = ''
    formsGet.mockImplementation(async () => ({ success: true, data: broken }))
    await render('id=form-1&tab=appearance')
    await screen.findByRole('heading', { name: '受付のきまり' })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(await screen.findByText('ページ2 のブロック')).toBeTruthy()
    const label = document.getElementById('fe-q-q2') as HTMLInputElement
    expect(label.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('fe-q-q2-error')?.textContent).toBe('質問文を入れてください')
    expect(document.activeElement).toBe(label)
    const tab = screen.getByRole('tab', { name: /中身/ })
    expect(tab.querySelector('[data-design-part="error-count-badge"]')?.textContent).toBe('1')
    expect(screen.queryByText('タイトルが空のブロックがあります')).toBeNull()
  })

  it('フォーム名が空のまま中身のタブで保存すると、その名前の欄へ移る', async () => {
    formsGet.mockImplementation(async () => ({ success: true, data: { ...structuredClone(formData), name: '' } }))
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(formsUpdate).not.toHaveBeenCalled()
    const name = document.getElementById('fe-name') as HTMLInputElement
    expect(name).toBeTruthy()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(name)
    const tab = screen.getByRole('tab', { name: '中身 中身に直す欄が1か所', exact: true })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.querySelector('[data-design-part="error-count-badge"]')?.textContent).toBe('1')
  })

  it('ほかの人が先に保存していたら（409）帯を出し、主のボタンは「比べてから保存」になる', async () => {
    formsUpdate.mockImplementation(async () => { throw new ApiError(409, 'conflict', 'VERSION_CONFLICT', { updatedAt: '' }) })
    // 再送の見分けで読み直したとき、中身が違う＝ほかの人の保存。
    formsGet.mockImplementationOnce(async () => ({ success: true, data: structuredClone(formData) }))
      .mockImplementation(async () => ({ success: true, data: { ...structuredClone(formData), name: '来店アンケート（マサト）' } }))
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalled())
    const title = await screen.findByText(/^ほかの人が.*フォーム「来店アンケート.*」を保存しました$/)
    const band = title.closest('[data-design-node="J1pdB"]') as HTMLElement
    expect(band).toBeTruthy()
    expect(within(band).getByRole('button', { name: '違いを比べる' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '比べてから保存' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'この版を公開' })).toBeNull()
  })

  it('「この版を公開」で確かめの窓を出し、窓の中で押すと保存してから公開する', async () => {
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    fireEvent.click(screen.getByRole('button', { name: 'この版を公開' }))
    const dialog = await screen.findByRole('dialog', { name: 'この版を公開する' })
    expect(within(dialog).getByText(/すでに集まった回答（1,284 件）は消えません/)).toBeTruthy()
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'この版を公開' }))
    await waitFor(() => expect(formsPublish).toHaveBeenCalledWith('form-1', 'acc-1', 8))
    expect(formsUpdate).toHaveBeenCalledWith('form-1', 'acc-1', expect.objectContaining({ expectedContentRevision: 7 }))
    expect(formsUpdate.mock.invocationCallOrder[0]).toBeLessThan(formsPublish.mock.invocationCallOrder[0])
  })

  it('確かめの窓の「変わること」は、公開中の版（account_id なしの取得）との違いと版の番号を出す', async () => {
    const { fetchApi } = await import('@/lib/api')
    const published = structuredClone(layout)
    published.sections[0].blocks = [
      published.sections[0].blocks[0],
      { id: 'q-old', kind: 'input', type: 'radio', name: 'trigger', label: 'ご来店のきっかけ', required: false, choiceMode: 'tag', choices: [{ id: 't1', label: '紹介' }] },
    ]
    vi.mocked(fetchApi).mockImplementation((async (path: string) => (
      path.startsWith('/api/forms/form-1?view=published')
        ? { success: true, data: { id: 'form-1', name: '来店アンケート', description: '', layout: published } }
        : { success: true, data: [] }
    )) as typeof fetchApi)
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    fireEvent.click(screen.getByRole('button', { name: 'この版を公開' }))
    const dialog = await screen.findByRole('dialog', { name: 'この版を公開する' })
    expect(within(dialog).getByText('変わること（版6 → 版7）')).toBeTruthy()
    expect(await within(dialog).findByText(/質問「今日のご来店の目的は？」を足した/)).toBeTruthy()
    expect(within(dialog).getByText(/質問「ご来店のきっかけ」を消した/)).toBeTruthy()
    expect(within(dialog).getByText('・公開するまで、いまの版6がそのまま使われます。')).toBeTruthy()
    expect(vi.mocked(fetchApi).mock.calls.some(([path]) => String(path).startsWith('/api/forms/form-1?view=published'))).toBe(true)
  })

  it('ブロックを足すと、その設定が開いて並びの最後に入る', async () => {
    await render('id=form-1')
    await screen.findByText('ページ1 のブロック')
    fireEvent.click(screen.getByRole('button', { name: /5段階の評価/ }))
    expect(await screen.findByText('5段階の評価', { selector: '[class*="openType"]' })).toBeTruthy()
  })
})

describe('回答フォームの下書き自動保存（一斉配信と同じ形）', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }) })
  afterEach(() => { vi.useRealTimers() })
  const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
  const status = () => host.querySelector('[data-autosave-status]')?.textContent ?? null

  it('打って2秒止まると下書きへ静かに保存し、次の手の保存は新しい版で送る', async () => {
    await render('id=form-1')
    fireEvent.change(screen.getByDisplayValue('今日のご来店の目的は？'), { target: { value: '今日のご来店の目的を教えてください' } })
    expect(status()).toBe('下書きはまだ保存していません')
    await wait(1900)
    expect(formsUpdate).not.toHaveBeenCalled()
    await wait(200)
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    expect(formsUpdate).toHaveBeenCalledTimes(1)
    expect(formsUpdate.mock.calls[0][2]).toEqual(expect.objectContaining({ expectedContentRevision: 7 }))
    expect(formsPublish).not.toHaveBeenCalled()
    expect(status()).toBe('下書き保存済み・0秒前')
    // 自動保存ではトースト・緑の帯を出さない。
    expect(document.body.textContent).not.toContain('下書きを保存しました')

    formsUpdate.mockImplementation(async () => ({ success: true, data: { id: 'form-1', contentRevision: 9, updatedAt: '' } }))
    fireEvent.change(screen.getByDisplayValue('今日のご来店の目的を教えてください'), { target: { value: '今日の目的は？' } })
    await act(async () => { fireEvent.click(getPageAction({ name: '下書きを保存' })) })
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    expect(formsUpdate).toHaveBeenCalledTimes(2)
    expect(formsUpdate.mock.calls[1][2]).toEqual(expect.objectContaining({ expectedContentRevision: 8 }))
  })

  it('自動保存に失敗したら下の帯から保存し直せ、成功したら失敗の表示を消す', async () => {
    formsUpdate.mockImplementation(async () => { throw new Error('network') })
    await render('id=form-1')
    fireEvent.change(screen.getByDisplayValue('今日のご来店の目的は？'), { target: { value: '今日の目的は？' } })
    await wait(2100)
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    expect(status()).toContain('自動保存できませんでした')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    const footer = host.querySelector('[data-template-region="footer"]') as HTMLElement
    const retry = within(footer).getByRole('button', { name: '下書きを保存' })
    expect(retry).toBeTruthy()
    expect(within(footer).queryByText('下書き・公開中と違います')).toBeNull()
    formsUpdate.mockResolvedValue({ success: true, data: { id: 'form-1', contentRevision: 8, updatedAt: '' } })
    await act(async () => { fireEvent.click(retry) })
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
    expect(formsUpdate).toHaveBeenCalledTimes(2)
    expect(formsPublish).not.toHaveBeenCalled()
    expect(status()).toBe('下書き保存済み・0秒前')
    expect(within(footer).queryByText('自動保存できませんでした')).toBeNull()
  })

  it('自動保存がほかの人の保存と競合したときは、比べる操作を優先する', async () => {
    formsUpdate.mockRejectedValue(new ApiError(409, 'conflict', 'VERSION_CONFLICT', { updatedAt: '' }))
    await render('id=form-1')
    fireEvent.change(screen.getByDisplayValue('今日のご来店の目的は？'), { target: { value: '今日の目的は？' } })
    await wait(2100)
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve() })
    const footer = host.querySelector('[data-template-region="footer"]') as HTMLElement
    expect(within(footer).getByRole('button', { name: '比べてから保存' })).toBeTruthy()
    expect(within(footer).queryByRole('button', { name: '下書きを保存' })).toBeNull()
    expect(within(footer).queryByRole('button', { name: 'この版を公開' })).toBeNull()
    expect(formsPublish).not.toHaveBeenCalled()
  })
})


describe('参考の文字の保存と読み直し', () => {
  const hintLabel = '参考の文字（入力欄の中に薄く出る）'
  const sample = () => {
    const l = emptyLayout()
    l.sections[0].blocks = [{ id: 'hint-q', kind: 'input', type: 'text', name: 'name', label: 'お名前' }]
    return l
  }
  const restart = () => {
    act(() => root.unmount())
    root = createRoot(host)
  }

  it('店で設定して保存→APIから読み直すと、設定と見本に残る。空にして保存すると消える', async () => {
    let stored = { ...structuredClone(formData), layout: sample() }
    formsGet.mockImplementation(async () => ({ success: true, data: structuredClone(stored) }))
    formsUpdate.mockImplementation(async (_id, _account, content) => {
      stored = { ...stored, layout: JSON.parse(JSON.stringify(content.layout)) }
      return { success: true, data: { id: stored.id, contentRevision: 8 } }
    })
    await render('id=form-1')
    fireEvent.change(screen.getByLabelText(hintLabel), { target: { value: '例：見本 141' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalled())
    restart()
    await render('id=form-1')
    expect((screen.getByLabelText(hintLabel) as HTMLInputElement).value).toBe('例：見本 141')
    expect(within(screen.getByLabelText('お客さまに見える形')).getByPlaceholderText('例：見本 141')).toBeTruthy()
    expect(formsPublish).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(hintLabel), { target: { value: '' } })
    formsUpdate.mockClear()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalled())
    restart()
    await render('id=form-1')
    expect((screen.getByLabelText(hintLabel) as HTMLInputElement).value).toBe('')
    expect(within(screen.getByLabelText('お客さまに見える形')).queryByPlaceholderText('例：見本 141')).toBeNull()
  })

  it('統括も同じ欄で設定し、ひな形を保存→読み直すと残る。店の保存APIは呼ばない', async () => {
    let stored: FormHostContent = { name: '回答のひな形', description: '', layout: sample(), onSubmitTagId: '' }
    const onSave = vi.fn(async (content: FormHostContent) => { stored = JSON.parse(JSON.stringify(content)); return true })
    const open = async () => {
      act(() => root.render(<FormEditV8 host={{ initial: stored, refs: EMPTY_REFS, accountName: 'ひな形', backHref: '/hq/form-submissions', statusLine: '下書き', distributedLine: 'まだ配っていません', busy: false, onSave, onCancel: vi.fn() }} />))
      await screen.findByLabelText(hintLabel)
    }
    await open()
    fireEvent.change(screen.getByLabelText(hintLabel), { target: { value: '例：統括の見本' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    restart()
    await open()
    expect((screen.getByLabelText(hintLabel) as HTMLInputElement).value).toBe('例：統括の見本')
    expect(within(screen.getByLabelText('お客さまに見える形')).getByPlaceholderText('例：統括の見本')).toBeTruthy()
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(formsGet).not.toHaveBeenCalled()
  })
})

describe('統括の保存結果と離脱', () => {
  const onCancel = vi.fn()
  async function openHost(onSave: FormEditHost['onSave']) {
    navigation.query = 'tab=appearance'
    const initial = { name: '回答のひな形', description: '', layout: emptyLayout(), onSubmitTagId: '' }
    act(() => root.render(<FormEditV8 host={{ initial, refs: EMPTY_REFS, accountName: 'ひな形', backHref: '/hq/form-submissions', statusLine: '下書き', distributedLine: 'まだ配っていません', busy: false, onSave, onCancel }} />))
    const input = await screen.findByLabelText('フォーム名')
    fireEvent.change(input, { target: { value: '保存したい名前' } })
    return input as HTMLInputElement
  }
  async function leaveBySaving() {
    fireEvent.click(getPageAction({ name: 'キャンセル' }))
    const dialog = within(await screen.findByRole('dialog', { name: '保存していない変更があります' }))
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: '下書きに保存して移る' })) })
  }

  it('離れる窓からの保存は確定を待ち、成功してから予定した操作を一度だけ行う', async () => {
    let finish!: (ok: boolean) => void
    const onSave = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    await openHost(onSave)
    await leaveBySaving()
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onCancel).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
    await act(async () => finish(true))
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: '保存したい名前' }), false)
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(formsGet).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'])('保存が通らないときは移らず入力を残し、次の離脱でも確認する（%s）', async result => {
    const onSave = result === 'refused' ? vi.fn(async () => false) : vi.fn(async () => { throw new Error('offline') })
    const input = await openHost(onSave)
    await leaveBySaving()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull())
    expect(input.value).toBe('保存したい名前')
    expect(onCancel).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
    await waitFor(() => expect((getPageAction({ name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getPageAction({ name: 'キャンセル' }))
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('通常の保存が確定した内容は未保存扱いにせず、キャンセルでそのまま移れる', async () => {
    const onSave = vi.fn(async () => true)
    await openHost(onSave)
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect((getPageAction({ name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getPageAction({ name: 'キャンセル' }))
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: '保存したい名前' }), false)
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  })

  it('保存して配るが成功しても、子から追加の移動を行わない', async () => {
    const onSave = vi.fn(async () => true)
    await openHost(onSave)
    fireEvent.click(getPageAction({ name: '保存して配る' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: '保存したい名前' }), true))
    expect(onCancel).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(formsPublish).not.toHaveBeenCalled()
  })
})

it('予約の担当候補が読めないとき、空にせず入力を保持してやり直す',async()=>{
 menuStaff.mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue({staff:[]})
 await render('id=form-1')
 const error=await screen.findByText('予約の担当を読み込めませんでした')
 expect(formsUpdate).not.toHaveBeenCalled()
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText('予約の担当を読み込めませんでした')).toBeNull())
 expect(menuStaff).toHaveBeenCalledTimes(2)
 expect(screen.getByDisplayValue('今日のご来店の目的は？')).toBeTruthy()
})

it('参照候補success:falseは空の候補で編集を進めない',async()=>{
 const spy=vi.spyOn(api.scenarios,'list').mockResolvedValue({success:false,error:'fixture failure'})
 await render('id=form-1')
 await waitFor(()=>expect(spy).toHaveBeenCalled())
 expect(await screen.findByText(/^(フォーム|候補)を読み込めませんでした$/)).toBeTruthy()
 spy.mockRestore()
})

describe('新しいフォームは最初の保存で作成する', () => {
  const token = '79c678bb-236b-42db-b5db-034b6d577e69'
  const query = `new=${token}&tab=appearance`
  beforeEach(() => { window.sessionStorage.clear() })
  const nameField = () => screen.getByLabelText('フォーム名') as HTMLInputElement

  it('未入力で開いてキャンセルしても書き込みはなく、回答用URLもまだ出さない', async () => {
    await render(query)
    expect(nameField().value).toBe('')
    expect(screen.getByText('最初に下書きを保存すると、回答用URLが表示されます。')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    expect(formsCreateDraft).not.toHaveBeenCalled()
    expect(formsGet).not.toHaveBeenCalled()
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  })

  it('名前が空のまま保存しても作成せず、欄の理由を表示する', async () => {
    await render(query)
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    expect(await screen.findByText('フォーム名を入力してください')).toBeTruthy()
    expect(formsCreateDraft).not.toHaveBeenCalled()
    expect(formsUpdate).not.toHaveBeenCalled()
  })

  it('最初の保存で一度だけ作り、内容の保存に失敗しても同じIDで再試行する', async () => {
    formsUpdate.mockRejectedValueOnce(new ApiError(503, 'offline'))
    await render(query)
    fireEvent.change(nameField(), { target: { value: '新しいフォーム' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledOnce())
    await waitFor(() => expect((getPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(false))
    expect(nameField().value).toBe('新しいフォーム')
    expect(formsCreateDraft).toHaveBeenCalledWith('acc-1', undefined, token)
    expect(formsUpdate).toHaveBeenCalledWith('form-created', 'acc-1', expect.objectContaining({ name: '新しいフォーム', expectedContentRevision: 1, isActive: false }))
    expect(navigation.replace).not.toHaveBeenCalled()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledTimes(2))
    expect(formsCreateDraft).toHaveBeenCalledOnce()
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/form-submissions\/edit\?id=form-created&tab=/), { scroll: false }))
    expect(formsPublish).not.toHaveBeenCalled()
  })

  it('作成の応答が途切れた後も同じ操作番号で再送し、入力を残す', async () => {
    formsCreateDraft.mockRejectedValueOnce(new ApiError(503, 'offline'))
    await render(query)
    fireEvent.change(nameField(), { target: { value: '残す名前' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsCreateDraft).toHaveBeenCalledOnce())
    await waitFor(() => expect((getPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(false))
    expect(nameField().value).toBe('残す名前')
    expect(formsUpdate).not.toHaveBeenCalled()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledOnce())
    expect(formsCreateDraft.mock.calls.map(call => call[2])).toEqual([token, token])
  })

  it('入力が止まると自動保存で作り、作成元の店と成功した版を記録する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    try {
      await render(query)
      fireEvent.change(nameField(), { target: { value: '自動保存のフォーム' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
      for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
      expect(formsCreateDraft).toHaveBeenCalledOnce()
      expect(formsUpdate).toHaveBeenCalledOnce()
      expect(readCreatedFormDraft('acc-1', 'form-created')).toBe(8)
      expect(readCreatedFormDraft('other-account', 'form-created')).toBeNull()
      expect(formsPublish).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('保存中に追記された入力を読み込みやURL切替で消さず、次の保存も同じIDを使う', async () => {
    let finish!: (value: unknown) => void
    formsUpdate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render(query)
    fireEvent.change(nameField(), { target: { value: '初めの入力' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledOnce())
    fireEvent.change(nameField(), { target: { value: '保存中の追記' } })
    await act(async () => finish({ success: true, data: { id: 'form-created', contentRevision: 2, updatedAt: '' } }))
    expect(nameField().value).toBe('保存中の追記')
    expect(formsGet).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsUpdate).toHaveBeenCalledTimes(2))
    expect(formsCreateDraft).toHaveBeenCalledOnce()
    expect(formsUpdate.mock.calls[1]).toEqual(['form-created', 'acc-1', expect.objectContaining({ name: '保存中の追記', expectedContentRevision: 2 })])
  })

  it('店を切り替えた後に前の作成結果が届いても、現在の店の入力や画面を変えない', async () => {
    let finish!: (value: unknown) => void
    formsCreateDraft.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render(query)
    fireEvent.change(nameField(), { target: { value: '前の店の入力' } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(formsCreateDraft).toHaveBeenCalledOnce())
    account.id = 'acc-2'
    await render(query)
    await act(async () => finish({ success: true, data: { id: 'old-store-draft', contentRevision: 1 } }))
    expect(nameField().value).toBe('')
    expect(formsUpdate).not.toHaveBeenCalled()
    expect(navigation.replace).not.toHaveBeenCalled()
    expect(readCreatedFormDraft('acc-2', 'old-store-draft')).toBeNull()
  })
})
