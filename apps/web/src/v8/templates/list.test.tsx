import { currentListLocation, flushListUrlState } from '@/components/shared/list-url-state'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 テンプレートの一覧（src/v8）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 行が出る・公開の札・閲覧のみの帯（サーバの役割で決まる）・
 * 使っていない（0か所）ものは窓なしで外して5秒は元に戻せる・数が分からないものは削除の確認、使っているものは削除できない窓。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listTemplates = vi.hoisted(() => vi.fn())
const folderList = vi.hoisted(() => ({ value: { success: true, data: [] as unknown[], unfiledCount: 2 }, list: null as null | ((...args: unknown[]) => unknown) }))
const usages = vi.hoisted(() => vi.fn())
const folderRemove = vi.hoisted(() => vi.fn(async () => ({ success: true })))
const heldFolder = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && typeof props.description === 'string' && props.description.includes('中のテンプレートは未分類') && props.onConfirm) heldFolder.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})
const removeTemplate = vi.hoisted(() => vi.fn())
const removeTemplates = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'account-1' }))
const push = vi.hoisted(() => vi.fn())
const fetchApi = vi.hoisted(() => vi.fn())

vi.mock('next/link', () => ({
  default: ({ children, href, className, title }: { children: React.ReactNode; href: string; className?: string; title?: string }) => (
    <a href={typeof href === 'string' ? href : '#'} className={className} title={title}>{children}</a>
  ),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/templates',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [{ id: 'account-1', name: '本店' }, { id: 'account-2', name: '別アカウント' }], selectedAccountId: account.id, loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: account.id }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => role.value,
  canManageRole: (r: string | null | undefined) => r === 'owner' || r === 'admin',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 0
  },
  fetchApi,
  api: {
    templates: { list: listTemplates, usages, delete: removeTemplate, bulkDelete: removeTemplates },
    friendFields: { list: () => Promise.resolve({ success: true, data: [{ fieldKey: 'pet_name', name: 'ペットの名前' }] }) },
    commonVars: { list: () => Promise.resolve({ success: true, data: [{ varKey: 'business_hours', name: '営業時間' }] }) },
    broadcastMessageAssets: { counts: () => Promise.resolve({ success: true, data: { card_message: 4 } }), list: () => Promise.resolve({ success: true, data: [] }), folders: { list: () => Promise.resolve({ success: true, data: [] }) } },
    folders: { list: (...args: unknown[]) => Promise.resolve(folderList.list ? folderList.list(...args) : folderList.value), delete: folderRemove },
  },
}))

import TemplatesListV8 from './list'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  confirmationRevision: 3,
  category: '',
  messageType: 'text',
  folderId: null,
  question: null,
  questionStatus: 'published',
  tapCount: 0,
  monthlySendCount: 10,
  totalSendCount: 20,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}
const used = { ...base, id: 't-used', name: '予約前日のご案内', messageContent: '明日のご予約です', usageCount: 11, publishedAt: '2026-08-01T00:00:00.000Z', hasDraft: true }
const unused = { ...base, id: 't-unused', accountId: 'account-2', name: '秋の新商品（画像）', messageType: 'image', messageContent: '{"originalContentUrl":"https://example.com/a.jpg"}', monthlySendCount: 0, totalSendCount: 0, usageCount: 0, publishedAt: null, hasDraft: true }

async function renderList() {
  await act(async () => {
    render(<TemplatesListV8 />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function openMenuAndDelete(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `テンプレート「${name}」の操作` }))
  fireEvent.click(screen.getByText('削除する'))
}

beforeEach(() => {
  account.id = 'account-1'
  flushListUrlState()
  window.history.replaceState(null, '', '/templates')
  window.dispatchEvent(new PopStateEvent('popstate'))
  document.documentElement.dataset.theme = 'v8'
  role.value = verifiedStaffRole('owner')
  listTemplates.mockResolvedValue({ success: true, data: [used, unused] })
  usages.mockResolvedValue({
    success: true,
    data: {
      broadcasts: [{ broadcastId: 'b1', title: '9月の予約リマインド', status: 'scheduled', scheduledAt: null, templateVersionNumber: 2, referenceMode: 'fixed' }],
      autoReplies: [{ id: 'a1', keyword: '予約変更のお問い合わせ', lineAccountId: null, templateVersion: null }],
      scenarioSteps: [{ scenarioId: 's1', scenarioName: '予約フォロー', stepId: 'st1', stepOrder: 1, templateVersion: null }],
    },
  })
  removeTemplate.mockResolvedValue({ success: true })
  removeTemplates.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  folderList.value = { success: true, data: [], unfiledCount: 2 }
  folderList.list = null
  clearToastsForTest()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('V8 テンプレートの一覧', () => {
  it('フォルダの編集中に履歴で種類が変わっても入力を保つ', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    try {
      await renderList()
      fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '編集中の分類' } })
      await act(async () => {
        window.history.replaceState(null, '', '/templates?tab=coupon')
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect((screen.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement).value).toBe('編集中の分類')
      expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    } finally { go.mockRestore() }
  })
  it('詳細の名前を編集中に画面を移ると入力を保って確認する', async () => {
    window.history.replaceState(null, '', '/templates?row=t-used')
    await renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'テンプレートの名前を変更する' }))
    const input = screen.getByRole('textbox', { name: 'テンプレートの名前' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '編集中の名前' } }); fireEvent.blur(input)
    const link = document.createElement('a'); link.href = '/webinars'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'テンプレートの名前' }) as HTMLInputElement).value).toBe('編集中の名前')
    link.remove()
  })
  it('空の動画・質問にも内容に合う説明を出す', async () => {
    listTemplates.mockResolvedValue({ success: true, data: [] })
    await renderList()
    for (const tab of ['リッチビデオ', '質問']) {
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) })) })
      expect(screen.getByText('よく使う内容を保存しておくと、一斉配信・自動応答・シナリオから選べます。')).toBeTruthy()
    }
  })

  it('差し込みのキーを実名へ置き換えて見せ、一覧の本文は保存値のままにする', async () => {
    listTemplates.mockResolvedValue({ success: true, data: [{ ...used, messageContent: '{{account.name}} {{var.business_hours}} {{field.pet_name}}' }] })
    await renderList()
    const thumb = document.querySelector('[data-line-bubble-thumb="text"]')!
    expect(thumb.textContent).toBe('LINE公式アカウント名 営業時間 ペットの名前')
    expect(thumb.querySelector('[data-token="{{var.business_hours}}"]')).toBeTruthy()
  })

  it('行と公開の札（未公開の変更・下書きだけ）が出る', async () => {
    await renderList()
    expect(screen.getByText('予約前日のご案内')).toBeTruthy()
    expect(screen.getByText('未公開の変更')).toBeTruthy()
    expect(screen.getByText('下書きだけ')).toBeTruthy()
    expect(screen.getByText('11か所')).toBeTruthy()
  })

  it('「すべて」はフォルダと未分類と同じサーバーの数の合計で、食い違わない', async () => {
    // 今のタブの行数で数えると、全種類を数えるサーバーの「未分類」と食い違う。
    folderList.value = { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: 5 }], unfiledCount: 9 }
    listTemplates.mockResolvedValue({ success: true, data: [{ ...used, folderId: 'f1' }, unused, { ...unused, id: 't-question', name: '質問', question: { type: 'single' } }] })
    await renderList()
    const counts = Object.fromEntries([...document.querySelectorAll('[data-part="folder-row"]')].map((row) => [row.getAttribute('title'), row.lastElementChild?.textContent]))
    expect(counts).toEqual({ すべて: '14', 予約: '5', 未分類: '9' })
  })

  it('フォルダの数は今のタブの種類だけをサーバーで数え、タブを替えると数え直す', async () => {
    const calls: unknown[][] = []
    folderList.list = (...args: unknown[]) => {
      calls.push(args)
      const question = args[2] === 'question'
      return { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: question ? 1 : 4 }], unfiledCount: question ? 0 : 3 }
    }
    listTemplates.mockResolvedValue({ success: true, data: [used, { ...unused, id: 't-question', name: '質問', question: { type: 'single' } }] })
    await renderList()
    const counts = () => Object.fromEntries([...document.querySelectorAll('[data-part="folder-row"]')].map((row) => [row.getAttribute('title'), row.lastElementChild?.textContent]))
    expect(calls.at(-1)).toEqual(['template', 'account-1', 'message'])
    expect(counts()).toEqual({ すべて: '7', 予約: '4', 未分類: '3' })
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /^質問/ })) })
    await act(async () => { await Promise.resolve() })
    expect(calls.at(-1)).toEqual(['template', 'account-1', 'question'])
    expect(counts()).toEqual({ すべて: '1', 予約: '1', 未分類: '0' })
  })

  it('画像は中身の JSON を出さず「画像 1枚」、一度も公開していないものの送信数は「—」', async () => {
    await renderList()
    expect(document.querySelector('[data-list-name]')?.textContent).not.toContain('画像 1枚')
    expect(screen.queryByText(/originalContentUrl/)).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('0通')).toBeNull()
  })

  // 2026-10-06 オーナー決定：閲覧のみには押せないボタンを置かずに隠す（帯は出す）。
  it('サーバの役割が staff なら閲覧のみの帯が出て、選ぶ枠と作るボタンは出さない', async () => {
    role.value = verifiedStaffRole('staff')
    await renderList()
    expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
    expect(screen.getByRole('button', { name: '種類を選んで作る' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryAllByRole('checkbox', { name: /を選択$/ })).toHaveLength(0)
  })

  it('オーナーには閲覧のみの帯を出さない', async () => {
    await renderList()
    expect(screen.queryByText('閲覧のみで見ています。変えたい時はオーナーか管理者に頼んでください。')).toBeNull()
  })

  it('決まり2：未使用の削除も確認してから実行する', async () => {
    await renderList()
    openMenuAndDelete('秋の新商品（画像）')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByRole('alertdialog').textContent).toContain('別アカウント')
    expect(screen.getByRole('alertdialog').textContent).toContain('環境')
    expect(screen.getByText('秋の新商品（画像）')).toBeTruthy()
    expect(removeTemplate).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })) })
    expect(removeTemplate).toHaveBeenCalledWith('t-unused')
  })

  it('まとめて削除には実際の対象アカウントを出す', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('checkbox', { name: '「秋の新商品（画像）」を選択' }))
    fireEvent.click(screen.getByRole('button', { name: 'まとめて削除' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('別アカウント')
    expect(screen.getByRole('alertdialog').textContent).toContain('環境')
  })

  it('削除の確認後にアカウントを行き来しても古い確定を受け付けない', async () => {
    const view = render(<TemplatesListV8 />)
    await act(async () => { await Promise.resolve() })
    openMenuAndDelete('秋の新商品（画像）')
    const button = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    account.id = 'account-2'; await act(async () => { view.rerender(<TemplatesListV8 />) })
    account.id = 'account-1'; await act(async () => { view.rerender(<TemplatesListV8 />) })
    await act(async () => { oldClick() })
    expect(removeTemplate).not.toHaveBeenCalled()
  })

  it.each(['単体', 'まとめて'])('%s削除の通信中に切り替えても新しいアカウントで削除できる', async (mode) => {
    let finishOld!: (value: unknown) => void
    const remove = mode === '単体' ? removeTemplate : removeTemplates
    remove.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockImplementation(() => new Promise(() => {}))
    const view = render(<TemplatesListV8 />)
    await act(async () => { await Promise.resolve() })
    const open = () => {
      if (mode === '単体') openMenuAndDelete('秋の新商品（画像）')
      else { fireEvent.click(screen.getByRole('checkbox', { name: '「秋の新商品（画像）」を選択' })); fireEvent.click(screen.getByRole('button', { name: 'まとめて削除' })) }
    }
    open()
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })) })
    expect(remove).toHaveBeenCalledTimes(1)
    account.id = 'account-2'
    await act(async () => { view.rerender(<TemplatesListV8 />); await Promise.resolve() })
    open()
    const dialog = screen.getByRole('alertdialog')
    expect((within(dialog).getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
    expect(remove).toHaveBeenCalledTimes(2)
    await act(async () => { finishOld({ success: true }); await Promise.resolve() })
    expect((within(dialog).getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(true)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('まとめて削除の窓を再表示すると古い確定は受け付けない', async () => {
    await renderList()
    fireEvent.click(screen.getByRole('checkbox', { name: '「秋の新商品（画像）」を選択' }))
    fireEvent.click(screen.getByRole('button', { name: 'まとめて削除' }))
    const button = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })
    const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: 'まとめて削除' }))
    await act(async () => { oldClick() })
    expect(removeTemplates).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })) })
    expect(removeTemplates).toHaveBeenCalledExactlyOnceWith([{ id: 't-unused', expectedRevision: 3 }])
  })

  it('決まり2：確認をキャンセルしたら削除しない', async () => {
    await renderList()
    openMenuAndDelete('秋の新商品（画像）')
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセル' })) })
    expect(screen.getByText('秋の新商品（画像）')).toBeTruthy()
    expect(removeTemplate).not.toHaveBeenCalled()
  })

  it('使っている数が分からないものは、今までどおり削除の確認を開き、押すと消す', async () => {
    listTemplates.mockResolvedValue({ success: true, data: [used, { ...unused, usageCount: undefined }] })
    await renderList()
    openMenuAndDelete('秋の新商品（画像）')
    expect(screen.getByText('「秋の新商品（画像）」を削除しますか？')).toBeTruthy()
    expect(screen.getByText('削除は元に戻せません。')).toBeTruthy()
    const dialog = screen.getByRole('alertdialog')
    const confirm = ([...dialog.querySelectorAll('button')].find((b) => b.textContent === '削除する') ?? querySupplementaryPageAction('削除する')) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(removeTemplate).toHaveBeenCalledWith('t-unused')
  })

  it('使っているものは消させず、使っている所を2行と残りの数で見せる', async () => {
    await renderList()
    openMenuAndDelete('予約前日のご案内')
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('「予約前日のご案内」はまだ消せません')).toBeTruthy()
    expect(screen.getByText('9月の予約リマインド')).toBeTruthy()
    expect(screen.getByText('予約変更のお問い合わせ')).toBeTruthy()
    expect(screen.queryByText('予約フォロー・1通目')).toBeNull()
    expect(screen.getByText('ほか 9 か所')).toBeTruthy()
    expect(screen.getAllByText('開いて差し替える')).toHaveLength(2)
    expect(removeTemplate).not.toHaveBeenCalled()
  })
})

describe('テンプレートの種類を選ぶ窓（R9XUMr）：見本から作る（F-5）', () => {
  beforeEach(() => {
    role.value = verifiedStaffRole('owner')
    push.mockReset()
    fetchApi.mockReset()
    listTemplates.mockResolvedValue({ success: true, data: [used] })
  })
  afterEach(() => cleanup())

  it('窓を開くと見本の口を読み、見本を押すとメッセージを作るへ見本の番号つきで進む', async () => {
    fetchApi.mockResolvedValue({
      success: true,
      data: [
        { id: 'template-example-booking', name: '予約の受付', body: 'ご予約を受け付けました。' },
        { id: 'broken', name: 1 },
      ],
    })
    await renderList()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '種類を選んで作る' })[0])
    })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('dialog', { name: 'どの種類を作りますか', exact: true })).toBeTruthy()
    expect(fetchApi).toHaveBeenCalledWith('/api/templates/examples')
    expect(screen.getByRole('heading', { name: '見本から作る' })).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /予約の受付/ }))
    })
    expect(push).toHaveBeenCalledWith('/templates/edit?example=template-example-booking')
  })

  it('見本が読めないときは段を出さず、種類のカードはそのまま押せる', async () => {
    fetchApi.mockRejectedValue(new Error('network'))
    await renderList()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '種類を選んで作る' })[0])
    })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: '見本から作る' })).toBeNull()
    expect(screen.getByRole('link', { name: 'カルーセル', exact: true }).getAttribute('href')).toBe('/templates/carousel')
  })
})

it('見本の取得失敗を見本なしとして消さず、同じ窓で読み直す',async()=>{
 role.value = verifiedStaffRole('owner')
 listTemplates.mockResolvedValue({success:true,data:[used]})
 fetchApi.mockReset().mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue({success:true,data:[]})
 await renderList()
 fireEvent.click(screen.getAllByRole('button',{name:'種類を選んで作る'})[0])
 const error=await screen.findByText('見本を読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await act(async()=>{})
 expect(fetchApi).toHaveBeenCalledTimes(2)
 expect(screen.queryByText('見本を読み込めませんでした')).toBeNull()
})

it('U2：題の共通説明を開いて閉じ、一覧の操作を保つ', async () => {
  await renderList()
  const help = screen.getByRole('button', { name: 'テンプレートの説明' })
  fireEvent.click(help)
  const descriptionId = help.getAttribute('aria-describedby')!
  expect(document.getElementById(descriptionId)?.textContent).toContain('直して公開すると、使っている所に反映されます。')
  fireEvent.keyDown(help, { key: 'Escape' })
  expect(document.getElementById(descriptionId)).toBeNull()
  expect(screen.getByText('予約前日のご案内')).toBeTruthy()
})

afterEach(() => { verifiedStaffRole(null) })

it('通数は排他的な切り替えで、差し込みと未使用は併用し、矢印でも条件を保つ', async () => {
  listTemplates.mockResolvedValue({ success: true, data: [used, unused, { ...used, id: 'multi', name: '複数', hasDraft: false, messageBubbles: [{ id: '1', type: 'text', text: 'a' }, { id: '2', type: 'text', text: 'b' }] }] })
  await renderList()
  const group = screen.getByRole('group', { name: 'メッセージの数' })
  const single = within(group).getByRole('button', { name: '1通のみ' })
  const multiple = within(group).getByRole('button', { name: '複数通' })
  fireEvent.click(single)
  fireEvent.click(screen.getByRole('button', { name: '差し込みあり' }))
  fireEvent.click(screen.getByRole('button', { name: '使っていない' }))
  expect(single.getAttribute('aria-pressed')).toBe('true')
  fireEvent.keyDown(single, { key: 'ArrowRight' })
  expect(multiple.getAttribute('aria-pressed')).toBe('true')
  expect(single.getAttribute('aria-pressed')).toBe('false')
  expect(document.activeElement).toBe(multiple)
  expect(screen.getByRole('button', { name: '差し込みあり' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: '使っていない' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(within(group).getByRole('button', { name: 'すべて', exact: true }))
  expect(single.getAttribute('aria-pressed')).toBe('false')
  expect(multiple.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: '使っていない' }).getAttribute('aria-pressed')).toBe('true')
})


it('C-10: 単一メッセージの改行やカルーセルを複数通と誤認せず、作成案内はテキストに限る', async () => {
  window.history.replaceState(null, '', '/templates')
  listTemplates.mockResolvedValue({ success: true, data: [{ ...used, messageContent: '一行目\n\n二行目' }, { ...unused, messageType: 'carousel' }] })
  await renderList()
  expect(within(screen.getByRole('group', { name: 'メッセージの数' })).queryByRole('button', { name: '複数通' })).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: '種類を選んで作る' })[0])
  expect(screen.queryByText('テキスト・カード型・画像。差し込みも使える')).toBeNull()
  expect(screen.getByText('テキスト。差し込みも使える')).toBeTruthy()
})

it('C-10: 保存された複数通だけを絞り込み、複数通の下書きも見つけられる', async () => {
  window.history.replaceState(null, '', '/templates')
  listTemplates.mockResolvedValue({ success: true, data: [used, { ...used, id: 'multi', name: '複数通の下書き', draftMessageBubbles: [{ id: '1', type: 'text', text: 'a' }, { id: '2', type: 'text', text: 'b' }] }] })
  await renderList()
  fireEvent.click(within(screen.getByRole('group', { name: 'メッセージの数' })).getByRole('button', { name: '複数通' }))
  expect(screen.getByText('複数通の下書き')).toBeTruthy()
  expect(screen.queryByText('予約前日のご案内')).toBeNull()
})


it('E-20: 質問タブのURLから開き、タブ切替もURLに残す', async () => {
  window.history.replaceState(null, '', '/templates?tab=question')
  window.dispatchEvent(new PopStateEvent('popstate'))
  listTemplates.mockResolvedValue({success:true,data:[used,{...unused,id:'q',name:'質問の内容',question:{type:'single'}}]})
  await renderList()
  expect(screen.getByRole('tab',{name:/^質問/}).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('質問の内容')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab',{name:/^メッセージ/}))
  expect(new URLSearchParams(currentListLocation().search).get('tab')).not.toBe('question')
})

it('C-10: 下書きが1通でも公開中の複数通を見失わない', async () => {
  listTemplates.mockResolvedValue({ success: true, data: [{ ...used, id: 'published-multi', name: '公開中は複数通', messageBubbles: [{ id:'1',type:'text',content:{text:'a'} },{ id:'2',type:'text',content:{text:'b'} }], draftMessageBubbles: null }] })
  await renderList()
  const multiple = within(screen.getByRole('group', { name: 'メッセージの数' })).getByRole('button', { name: '複数通' })
  fireEvent.click(multiple)
  expect(screen.getByText('公開中は複数通')).toBeTruthy()
})

it('テンプレートフォルダの削除窓に所有アカウントと環境を出す', async () => {
  folderList.value = { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: 1, accountId: 'account-1' }], unfiledCount: 0 }
  await renderList()
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('本店')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})

it('共通フォルダの削除窓は選択中のアカウントではなく共通の対象を示す', async () => {
  folderRemove.mockClear()
  folderList.value = { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: 1, accountId: null }], unfiledCount: 0 }
  await renderList()
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText('共通（全アカウント）')).toBeTruthy()
  expect(within(dialog).queryByText('本店')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  await act(async () => { await Promise.resolve() })
  expect(folderRemove).toHaveBeenCalledWith('f1', undefined)
})

it.each([{ accountId: 'account-2' }, {}])('所有先が異なるか不明なフォルダは削除しない %o', async (owner) => {
  folderRemove.mockClear()
  folderList.value = { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: 1, ...owner }], unfiledCount: 0 }
  await renderList()
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const dialog = await screen.findByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  expect(folderRemove).not.toHaveBeenCalled()
  expect(dialog.textContent).toContain('フォルダの所有先を確認できません')
})

it('テンプレートフォルダの閉じた確認は削除しない', async () => {
  folderRemove.mockClear()
  folderList.value = { success: true, data: [{ id: 'f1', name: '予約', color: null, displayOrder: 0, itemCount: 1, accountId: 'account-1' }], unfiledCount: 0 }
  await renderList()
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「予約」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const previous = heldFolder.confirm!
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await previous() })
  expect(folderRemove).not.toHaveBeenCalled()
})
