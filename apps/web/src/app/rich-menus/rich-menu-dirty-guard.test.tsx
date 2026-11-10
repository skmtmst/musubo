import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/rich-menus/" }
import React, { act } from 'react'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { pickDateTime } from '@/test-utils/rich-menu-editor'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const searchParams = vi.hoisted(() => ({ value: new URLSearchParams() }))
const routerPush = vi.hoisted(() => vi.fn())
const richMenuGet = vi.hoisted(() => vi.fn())
const richMenuUpdate = vi.hoisted(() => vi.fn())
const richMenuSchedule = vi.hoisted(() => vi.fn())
const richMenuPublish = vi.hoisted(() => vi.fn())
const richMenuPreviewTargets = vi.hoisted(() => vi.fn())
const richMenuDuplicate = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', async () => {
  const router = {
    push: routerPush, replace: () => {}, refresh: () => {},
    back: () => {}, forward: () => {}, prefetch: () => {},
  }
  return { ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => router,
  useSearchParams: () => searchParams.value,
  usePathname: () => '/rich-menus/edit',
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
const selectedAccount = vi.hoisted(() => ({ id: 'acc-1', name: 'テスト店' }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount,
    accounts: [], loading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
}))

/*
 * 条件の組み立て部品は複雑なので、ここでは「押すと条件が1件入る」
 * 最小のスタブにする。試したいのは条件の保存状態の言い分けで、
 * 条件の組み立て自体ではない。
 */
vi.mock('@/components/shared/condition-builder', () => ({
  default: ({ onChange, label }: { onChange?: (value: unknown) => void; label?: string }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'aria-label': label ?? '条件',
        onClick: () =>
          onChange?.({ operator: 'AND', rules: [{ type: 'name', value: { text: '追加した条件' } }] }),
      },
      '条件を足す(スタブ)',
    ),
}))

const GROUP = {
  id: 'grp-1', accountId: 'acc-1', name: 'メインメニュー', chatBarText: 'メニュー',
  size: 'large' as const, defaultPageId: 'pg-1', isDefaultForAll: false,
  status: 'draft' as const, publishingAt: null,
  targetingCondition: null, targetingPriority: 0, targetingEnabled: false,
  folderId: null,
  version: 1,
  publishingGeneration: 0,
  pages: [{
    id: 'pg-1', orderIndex: 0, name: 'トップ', aliasId: '',
    lineRichmenuId: null, imageR2Key: null, imageContentType: null, areas: [],
  }],
}

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const mocked = await (() => ({
  ApiError: class ApiError extends Error {},
  describeSaveFailure: () => '保存できませんでした。もう一度お試しください。',
  api: {
    folders: { list: () => Promise.resolve({ success: true, data: [] }) },
    tags: { list: () => Promise.resolve({ success: true, data: [] }) },
    templates: { list: () => Promise.resolve({ success: true, data: [] }) },
    forms: { list: () => Promise.resolve({ success: true, data: [] }) },
    trackedLinks: { list: () => Promise.resolve({ success: true, data: [] }) },
    richMenuGroups: {
      get: richMenuGet,
      update: richMenuUpdate,
      tapStats: () => Promise.resolve({ success: true, data: { byArea: [] } }),
      list: () => Promise.resolve({ success: true, data: [{ ...GROUP, id: 'restore-1', name: '戻すメニュー', status: 'published' }] }),
      listSchedules: () => Promise.resolve({ success: true, data: [] }),
      schedule: richMenuSchedule,
      publish: richMenuPublish,
      previewTargets: richMenuPreviewTargets,
      duplicate: richMenuDuplicate,
      audienceSummary: () => Promise.resolve({ success: true, data: { total: { value: 0, state: 'available', reason: null }, targeted: { value: 0, state: 'available', reason: null }, excluded: { value: 0, state: 'available', reason: null }, effective: { value: 0, state: 'available', reason: null } } }),
      prepublishCheck: () => Promise.resolve({ success: true, data: { selfCheck: { ok: true }, deviceConfirmed: true, deviceConfirmedAt: null, pageCount: 1, maxPages: 20 } }),
      validatePublish: () => Promise.resolve({ success: true, data: { checks: [{ key: 'self', ok: true }, { key: 'line', ok: true }] } }),
      publishProgress: () => Promise.resolve({ success: true, data: { steps: [], message: null, run: { status: 'done' } } }),
      publishRuns: () => Promise.resolve({ success: true, data: { runs: [] } }),
      reconcile: () => Promise.resolve({ success: true, data: { diffs: [] } }),
      imageUrl: (key: string) => `/img/${key}`,
    },
    // N-152/N-156: 編集画面は操作者の役割を読んで staff には集計だけを出す。
    staff: { me: () => Promise.resolve({ success: true, data: { role: 'owner' } }) },
  },
}))()
  return { ...actual, ...mocked }
})

import NewRichMenuPage from '../../v8/rich-menus/new/create'
import RichMenuDetailV8 from '@/v8/rich-menu-edit/detail'

function CurrentRichMenuEdit() {
  window.history.replaceState(null, '', '/rich-menus/edit?' + searchParams.value.toString())
  return <NewRichMenuPage editGroupId={searchParams.value.get('id') ?? undefined} />
}

async function flush() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function type(input: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** searchParams を差し替えて再描画し、画面内の工程移動を再現する。 */
async function gotoStep(_view: ReturnType<typeof render>, step: string | null) {
  const labels: Record<string, string> = { shape: '形と画像', targeting: '誰に出すか', publish: '公開' }
  fireEvent.click(within(screen.getByRole('navigation', { name: 'リッチメニューを作る手順' })).getByRole('button', { name: new RegExp(`^${labels[step ?? 'shape']}に(戻る|進む)$`) }))
  await flush()
}

async function fillPublishSchedule() {
  fireEvent.click(screen.getByRole('radio', { name: /日時を決めて公開する/ }))
  await flush()
  await pickDateTime('公開を始める日時', '2026-10-01T10:00')
  fireEvent.click(screen.getAllByRole('button', { name: '見直す' })[1])
  await flush()
}

/** 試験ごとに空で始めるための localStorage 代替。 */
class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

beforeEach(() => {
  // happy-dom は <a href> のクリックで実際に location を動かすため、
  // 先行テストの遷移が残らないよう毎回URLを戻す。
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM
    .setURL('http://localhost/rich-menus/')
  searchParams.value = new URLSearchParams()
  routerPush.mockReset()
  richMenuGet.mockReset()
  richMenuGet.mockImplementation((id: string) => Promise.resolve({ success: true, data: { ...GROUP, id } }))
  richMenuUpdate.mockReset()
  richMenuUpdate.mockImplementation(() => Promise.resolve({ success: true, data: GROUP }))
  richMenuSchedule.mockReset()
  richMenuSchedule.mockImplementation(() => Promise.resolve({ success: true, data: { id: 'sch-1' } }))
  richMenuPublish.mockReset()
  richMenuPublish.mockImplementation(() => Promise.resolve({ success: true, data: { pages: [] } }))
  richMenuDuplicate.mockReset()
  richMenuDuplicate.mockImplementation(() => Promise.resolve({ success: true, data: { id: 'copy-1' } }))
  // 公開入力の下書きは localStorage に残る。試験ごとに空で始める。
  vi.stubGlobal('localStorage', new MemoryStorage())
  richMenuPreviewTargets.mockReset()
  richMenuPreviewTargets.mockImplementation(() => Promise.resolve({ success: true, data: null }))
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('リッチメニュー新規作成の未保存ガード (N-162)', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  test('未入力のまま一覧リンクを押しても確認は出ない', async () => {
    render(<NewRichMenuPage />)
    await flush()

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
    expect(routerPush).not.toHaveBeenCalled()
  })

  test('入力後に一覧リンクを押すと確認が出て、続けるを選ぶと残る', async () => {
    render(<NewRichMenuPage />)
    await flush()

    await type(screen.getByLabelText('メニュー名（友だちには見えません）'), '季節メニュー')
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()

    // 確認窓が出て遷移は止まる
    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(routerPush).not.toHaveBeenCalled()

    // 「編集を続ける」で閉じる
    fireEvent.click(screen.getByText('編集を続ける'))
    await flush()
    await waitFor(() => expect(screen.queryByText('保存していない変更があります')).toBeNull())
    // 入力は残る
    expect((screen.getByLabelText('メニュー名（友だちには見えません）') as HTMLInputElement).value).toBe('季節メニュー')
  })

  test('確認で「保存せずに移る」を選ぶと遷移する', async () => {
    render(<NewRichMenuPage />)
    await flush()

    await type(screen.getByLabelText('メニュー名（友だちには見えません）'), '季節メニュー')
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    fireEvent.click(screen.getByText('保存せずに移る'))
    await flush()
    expect(routerPush).toHaveBeenCalledWith('/rich-menus')
  })

  test('入力中の再読み込みはbeforeunloadで止まる', async () => {
    render(<NewRichMenuPage />)
    await flush()

    await type(screen.getByLabelText('メニュー名（友だちには見えません）'), '季節メニュー')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('リッチメニュー編集の未保存ガード (N-162)', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  test('開き直した下書きでも「公開」はまだ済みの印にせず番号のまま、押せば進める（OxEMM）', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByDisplayValue('メインメニュー').catch(() => null)
    const nav = screen.getByRole('navigation', { name: 'リッチメニューを作る手順' })
    const items = Array.from(nav.querySelectorAll('li'))
    const publish = items[items.length - 1]
    expect(publish.getAttribute('data-step-state')).toBe('todo')
    expect(publish.querySelector('[data-step-dot]')?.textContent).toBe('4')
    expect(within(nav).getByRole('button', { name: '公開に進む' })).toBeTruthy()
    expect(items[0].getAttribute('data-step-state')).toBe('done')
  })

  test('読み込み直後は変更なしなので一覧リンクを押しても確認は出ない', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=shape')
    render(<CurrentRichMenuEdit />)
    await flush()

    await screen.findByDisplayValue('メインメニュー')
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
  })

  test('変更後に一覧リンクを押すと確認が出る', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=shape')
    render(<CurrentRichMenuEdit />)
    await flush()

    const nameInput = await screen.findByDisplayValue('メインメニュー')
    await type(nameInput, 'メインメニュー改')
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()

    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(routerPush).not.toHaveBeenCalled()
  })

  test('保存し終わると警告は出なくなる', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=shape')
    render(<CurrentRichMenuEdit />)
    await flush()

    const nameInput = await screen.findByDisplayValue('メインメニュー')
    await type(nameInput, 'メインメニュー改')
    // 保存（update→再読込で署名が更新される）
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await act(async () => { await Promise.resolve() })
    await flush()

    expect(richMenuUpdate).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
  })

  test('step=targeting でも離脱確認が出る（どの段階でも窓は届く）', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    render(<CurrentRichMenuEdit />)
    await flush()

    // 出し分けをONにしてdirty化（2つ目の audience radio が「条件に当てはまる友だちだけ」）
    await screen.findByRole('radio', { name: /条件に当てはまる友だちだけ/ })
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="audience"]')
    fireEvent.click(radios[1])
    await flush()
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()

    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(routerPush).not.toHaveBeenCalled()
  })

  test('ステップ移動は同一画面の段階移動なので確認を出さない', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=shape')
    render(<CurrentRichMenuEdit />)
    await flush()

    const nameInput = await screen.findByDisplayValue('メインメニュー')
    await type(nameInput, 'メインメニュー改')
    // StepHeader の「誰に出すか」（step=targeting）を押しても、入力は消えない画面内移動
    const stepButton = screen.getAllByText('誰に出すか').find((el) => el.closest('button'))
    fireEvent.click(stepButton!.closest('button')!)
    await flush()
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
    expect(routerPush).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /条件に当てはまる友だちだけ/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '形と画像に戻る' }))
    await flush()
    expect(screen.getByDisplayValue('メインメニュー改')).toBeTruthy()
  })
})

/*
 * RICHMENU-06: STEP3「公開のしかた」の入力は工程をまたいで保持する。
 * 以前は工程の部品の中にだけ状態があり、STEP2→STEP3 の往復で
 * 「いますぐ出す」へ黙って戻り、日時も消えていた。
 */
describe('公開のしかたの入力保持 (RICHMENU-06)', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  test('日時を決めて出す＋日時入力がSTEP1→STEP3の往復で消えない', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()

    await gotoStep(view, null)
    await screen.findByDisplayValue('メインメニュー')
    await gotoStep(view, 'publish')
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    const radios = document.querySelectorAll<HTMLInputElement>('input[name="timing"]')
    expect(radios[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
  })

  test('期間を決める＋出しおわり＋戻し先がSTEP往復で消えない', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    const radios = document.querySelectorAll<HTMLInputElement>('input[name="timing"]')
    fireEvent.click(radios[1])
    fireEvent.click(screen.getByRole('switch', { name: '終わりを決める' }))
    await flush()
    await pickDateTime('公開を始める日時', '2026-10-01T10:00')
    await pickDateTime('終わる日時', '2026-10-07T10:00')
    await pickEntity('終わったらどうする', '戻すメニュー')

    await gotoStep(view, 'targeting')
    await screen.findByRole('radio', { name: /条件に当てはまる友だちだけ/ })
    await gotoStep(view, 'publish')
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
    expect(screen.getByLabelText('終わる日時').textContent).toContain('2026年10月7日（水）10:00')
    expect(screen.getByText('戻すメニュー')).toBeTruthy()
  })

  test('公開日時を入れたまま一覧へ離れると確認が出る（dirty署名に含まれる）', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(routerPush).not.toHaveBeenCalled()
  })

  test('離脱確認を取消すと公開入力はそのまま残る', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    fireEvent.click(screen.getByText('編集を続ける'))
    await flush()

    await waitFor(() => expect(screen.queryByText('保存していない変更があります')).toBeNull())
    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
  })

  test('「保存せずに移る」を選ぶと公開入力は初期値へ戻る', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    fireEvent.click(screen.getByText('保存せずに移る'))
    await flush()
    expect(routerPush).toHaveBeenCalledWith('/rich-menus')

    // 捨てることを選んだので、開き直すと「いますぐ出す」・日時なしに戻る
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    view.rerender(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[0].checked).toBe(true)
    expect(screen.queryByLabelText('公開を始める日時')).toBeNull()
  })

  test('下書き保存に失敗しても公開方法と日時は残る', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()

    richMenuUpdate.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'x' }))
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await flush()

    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
  })

  test('公開予約を保存できたら、その内容は未保存扱いにしない', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    await fillPublishSchedule()
    fireEvent.click(screen.getByRole('button', { name: '予約する' }))
    await flush()
    expect(richMenuSchedule).toHaveBeenCalled()
    expect(richMenuSchedule).toHaveBeenCalledWith('grp-1', {
      mode: 'scheduled', startsAt: '2026-10-01T01:00:00.000Z', endsAt: null, restoreGroupId: null,
    }, expect.any(String))

    // 予約できた内容は保存済みなので、一覧への離脱で確認は出ない
    await screen.findByRole('heading', { name: '公開予約を受け付けました' })
    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
  })
})

/*
 * DEEP-27: 未保存で足した条件が「保存済み条件」と出ると、保存したつもりで
 * 画面を離れてしまう。保存済みの条件と同じかどうかで表示を分ける。
 */
describe('条件の保存状態の表示 (DEEP-27)', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  const GROUP_WITH_CONDITION = {
    ...GROUP,
    targetingEnabled: true,
    targetingCondition: JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'private_memo', value: '保存済み' }],
    }),
  }

  test('保存済み条件は「保存済み」、直した条件は「未保存」と区別する', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_WITH_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    render(<CurrentRichMenuEdit />)
    await flush()

    await screen.findByText('保存済み条件 1件')

    // スタブの条件組み立て: 押すと別の条件が1件入る
    fireEvent.click(screen.getByText('条件を足す(スタブ)'))
    await flush()

    expect(screen.getByText('条件 1件（未保存）')).toBeTruthy()
    expect(screen.queryByText('保存済み条件 1件')).toBeNull()
  })
})

/*
 * RICHMENU-03: 条件をONにしたのに条件が空だと保存できず誰にも出ない。
 * STEP1 は「誰にも出しません」と案内するが、STEP2 は人数APIが空条件を
 * 全員として数えるため「当てはまる5人/出る5人」と食い違って見えた。
 * 対象の説明を両工程で揃える（数え方そのものは変えない）。
 */
describe('条件が空のときの対象説明 (RICHMENU-03)', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  const GROUP_EMPTY_CONDITION = {
    ...GROUP,
    targetingEnabled: true,
    targetingCondition: null,
  }
  const EMPTY_WARNING = '条件が空のままだと、公開しても誰にも出ません。'

  test('条件ON・空条件ではSTEP2も「誰にも出しません」で0人と案内する', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_EMPTY_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    render(<CurrentRichMenuEdit />)
    await flush()

    await screen.findByRole('radio', { name: /条件に当てはまる友だちだけ/ })
    expect(screen.getByText(EMPTY_WARNING)).toBeTruthy()
    // 「いま当てはまる人」「実際にこのメニューが出る人」は 0人 と出す
    expect(screen.getAllByText('0人')).toHaveLength(2)
  })

  test('同じ状態でSTEP1も同じ案内を出す', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_EMPTY_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=shape')
    render(<CurrentRichMenuEdit />)
    await flush()

    await screen.findByDisplayValue('メインメニュー')
    fireEvent.click(screen.getByRole('button', { name: '画面の説明' }))
    expect(screen.getByText(/条件が空のままだと、公開しても誰にも出ません/)).toBeTruthy()
  })
})

/*
 * 公開前チェックの人数は、保存前の条件ではなく「いま編集中の条件」で数える。
 * 人数API(previewTargets)には常に編集中の条件を渡す。条件が空なら
 * STEP2 と同じく 0人＋誰にも出しません にそろえる。
 */
describe('公開前チェックの人数（未保存条件）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  const GROUP_WITH_CONDITION = {
    ...GROUP,
    targetingEnabled: true,
    targetingCondition: JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'private_memo', value: '保存済み' }],
    }),
  }
  const STUB_CONDITION = {
    operator: 'AND',
    rules: [{ type: 'name', value: { text: '追加した条件' } }],
  }

  async function editConditionUnsaved() {
    // スタブの条件組み立て: 押すと別の条件が1件入る
    fireEvent.click(screen.getByText('条件を足す(スタブ)'))
    await flush()
  }

  /**
   * 人数の再取得は250msのデバウンス。偽の時計で進めてから通信の引数を見る（本物の時間を待たない）。
   * デバウンスは条件を直した瞬間から数えるので、直す前に偽の時計へ替える（editConditionUnsaved の前）。
   */
  async function waitPreviewFetch() {
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    vi.useRealTimers()
    await flush()
  }

  test('条件を未保存で直すと、人数APIへその未保存条件が渡る', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_WITH_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('radio', { name: /条件に当てはまる友だちだけ/ })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await editConditionUnsaved()
    await waitPreviewFetch()

    expect(richMenuPreviewTargets).toHaveBeenCalled()
    expect(richMenuPreviewTargets).toHaveBeenLastCalledWith('grp-1', STUB_CONDITION)
    // 人数のそばに「未保存の条件で数えている」と出る
    expect(screen.getByText('人数はまだ保存していない条件で数えています')).toBeTruthy()
  })

  test('未保存の条件では、STEP3の公開前チェックと右の欄にも注記が出る', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_WITH_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=targeting')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('radio', { name: /条件に当てはまる友だちだけ/ })
    await editConditionUnsaved()

    await gotoStep(view, 'publish')
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    // 公開前チェックの人数に「未保存の条件で計算」、右の欄に「（未保存の条件）」
    expect(screen.getByText(/未保存の条件で計算/)).toBeTruthy()
    expect(screen.getByText('（未保存の条件）')).toBeTruthy()
  })

  test('保存済みの条件のままなら、注記は出ない', async () => {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_WITH_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    expect(screen.queryByText(/未保存の条件/)).toBeNull()
  })

  test('条件が空なら STEP3 も 0人＋誰にも出しません にそろう', async () => {
    const GROUP_EMPTY_CONDITION = { ...GROUP, targetingEnabled: true, targetingCondition: null }
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: GROUP_EMPTY_CONDITION }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    // 空条件は誰にも出ない。人数APIの全員カウントで誤魔化さない。
    expect(screen.getByText(/誰の画面にも出ません（0人）/)).toBeTruthy()
    expect(screen.queryByText(/誰に出すかが決まっています/)).toBeNull()
    // 右の欄と「公開すると何が変わるか」も 0人 でそろえる
    expect(screen.getByText('0人')).toBeTruthy()
    // R204: 条件が空なら「全員の画面が変わる」ではなく「誰にも出ない」と説明する
    expect(screen.getByText(/公開しても今は誰の画面にも出ません/)).toBeTruthy()
  })
})

/*
 * 公開のしかたの入力は、サーバーの下書きpayloadに乗せる欄が無いので
 * メニューIDごとに localStorage へ下書き保存する。再読込・タブ終了で
 * 消えず、別メニューの下書きと混ざらない。「保存せずに移る」・公開予約の
 * 保存成功・LINE登録・メニュー削除で消す。
 */
describe('公開入力の下書き（localStorage）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  const DRAFT_KEY = 'lh_rich_menu_publish_plan_grp-1'

  test('再読込すると公開方法と日時が復元される', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    await fillPublishSchedule()
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy()

    // ブラウザ再読込相当（アンマウントして開き直す）
    view.unmount()
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })

  test('期間公開の入力（出しおわり・戻し先）も復元される', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    const radios = document.querySelectorAll<HTMLInputElement>('input[name="timing"]')
    fireEvent.click(radios[1])
    fireEvent.click(screen.getByRole('switch', { name: '終わりを決める' }))
    await flush()
    await pickDateTime('公開を始める日時', '2026-10-01T10:00')
    await pickDateTime('終わる日時', '2026-10-07T10:00')
    await pickEntity('終わったらどうする', '戻すメニュー')

    view.unmount()
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })

    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
    expect(screen.getByLabelText('終わる日時').textContent).toContain('2026年10月7日（水）10:00')
    expect(screen.getByText('戻すメニュー')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toMatchObject({ restoreGroupId: 'restore-1' })
  })

  test('「保存せずに移る」を選ぶと下書きも消える', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    await fillPublishSchedule()
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await flush()
    fireEvent.click(screen.getByText('保存せずに移る'))
    await flush()

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  test('公開予約の保存に成功すると下書きは消える', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    await fillPublishSchedule()
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '予約する' }))
    await flush()

    expect(richMenuSchedule).toHaveBeenCalled()
    // 予約できた内容が「未保存の入力」として復活しないよう、下書きは消す
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  test('LINE登録に成功すると下書きは消える', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    await fillPublishSchedule()

    // 「いますぐ出す」へ戻しても日時は入力の中に残り、下書きも残る
    fireEvent.click(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[0])
    await flush()
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '公開する' }))
    await flush()

    const dialog = await screen.findByRole('dialog', { name: '公開の確認' })
    fireEvent.click(within(dialog).getByRole('button', { name: '公開する' }))
    await flush()
    expect(richMenuPublish).toHaveBeenCalled()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  test('別メニューにはそのメニューの下書きだけが復元される', async () => {
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    const view = render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    await fillPublishSchedule()

    // 別メニュー（grp-2）の編集へ移る。grp-1 の下書きは出ない。
    searchParams.value = new URLSearchParams('id=grp-2&step=publish')
    view.rerender(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[0].checked).toBe(true)
    expect(screen.queryByLabelText('公開を始める日時')).toBeNull()
    // grp-1 の下書き自体は消えない
    expect(localStorage.getItem(DRAFT_KEY)).toBeTruthy()

    // grp-1 へ戻ると下書きが復元される
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    view.rerender(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    expect(document.querySelectorAll<HTMLInputElement>('input[name="timing"]')[1].checked).toBe(true)
    expect(screen.getByLabelText('公開を始める日時').textContent).toContain('2026年10月1日（木）10:00')
  })
})

/*
 * R204/R205: 公開画面の「何が変わるか」は、実際の動きと編集中の設定に
 * 合わせて言い分ける。以前は常に「N人 のトーク画面のメニューが
 * 入れ替わります」と出て、条件で出し分ける設定でも全員に変わるように
 * 読めた。
 */
describe('R204 公開すると何が変わるか（設定に合わせた説明）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  async function renderPublish(group: typeof GROUP) {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: group }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
  }

  test('全員の既定のときは「すべての友だちの画面に出る」と説明する', async () => {
    await renderPublish({ ...GROUP, isDefaultForAll: true })
    expect(screen.getByTitle(/すべての友だちのトーク画面に出ます/)).toBeTruthy()
    expect(screen.queryByText(/登録だけでは/)).toBeNull()
  })

  test('条件で出し分けるときは「順次切り替わる」と説明し、全員にすぐ出るとは言わない', async () => {
    await renderPublish({
      ...GROUP,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }),
    })
    expect(screen.getByTitle(/順次切り替わります/)).toBeTruthy()
    expect(screen.getByTitle(/すぐ全員に出るわけではありません/)).toBeTruthy()
    expect(screen.queryByText(/すべての友だちのトーク画面に出ます/)).toBeNull()
  })

  test('対象設定なしなら「登録だけでは画面は変わらない」と説明する', async () => {
    await renderPublish(GROUP)
    expect(screen.getByTitle(/LINEへの登録だけでは、友だちのトーク画面は変わりません/)).toBeTruthy()
    expect(screen.getByTitle(/「表示先」で出す相手を決めてください/)).toBeTruthy()
  })

  test('公開が終わると、設定に合った完了文が出る', async () => {
    await renderPublish(GROUP)
    fireEvent.click(screen.getAllByRole('button', { name: '見直す' })[1])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '公開する' }))
    await flush()
    const dialog = await screen.findByRole('dialog', { name: '公開の確認' })
    fireEvent.click(within(dialog).getByRole('button', { name: '公開する' }))
    await flush()
    expect(richMenuPublish).toHaveBeenCalled()
    expect(richMenuUpdate).toHaveBeenCalledWith('grp-1', expect.objectContaining({ isDefaultForAll: false, targetingEnabled: false }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '公開の確認' })).toBeNull())
    expect(screen.getByText(/一覧の「表示先」から操作してください/)).toBeTruthy()
    // 対象設定なしなのに「全員の画面が変わった」とは言わない
    expect(screen.queryByText(/既定メニューになりました/)).toBeNull()
  })
})

/*
 * R204残差: 公開の確認窓も aside・完了文と同じく設定別に出る人を言う。
 * 全設定共通の「出ません／友だちに表示を実行」は、全員既定・条件ありと矛盾する。
 */
describe('R204 公開の確認窓（設定に合わせた説明）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  async function openPublishConfirm(group: typeof GROUP) {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: group }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
    fireEvent.click(screen.getAllByRole('button', { name: '見直す' })[1])
    await flush()
    fireEvent.click(screen.getByRole('button', { name: '公開する' }))
    await flush()
    expect(richMenuPublish).not.toHaveBeenCalled()
  }

  test('全員の既定なら「個別指定を除く全友だち」と言う', async () => {
    await openPublishConfirm({ ...GROUP, isDefaultForAll: true })
    const dialog = screen.getByRole('dialog', { name: '公開の確認' })
    expect(within(dialog).getByText(/個別に指定した人を除く/)).toBeTruthy()
    expect(within(dialog).queryByText(/友だちのトーク画面には出ません/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '公開の確認' })).toBeNull())
    expect(richMenuPublish).not.toHaveBeenCalled()
  })

  test('条件ありなら「出来事で順次」と言う', async () => {
    await openPublishConfirm({
      ...GROUP,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }),
    })
    const dialog = screen.getByRole('dialog', { name: '公開の確認' })
    expect(within(dialog).getByText(/順次出ます/)).toBeTruthy()
    expect(within(dialog).queryByText(/友だちのトーク画面には出ません/)).toBeNull()
  })

  test('条件が空なら「今0人」と言い、直し方も添える', async () => {
    await openPublishConfirm({ ...GROUP, targetingEnabled: true, targetingCondition: null })
    const dialog = screen.getByRole('dialog', { name: '公開の確認' })
    expect(within(dialog).getByText(/今0人/)).toBeTruthy()
    expect(within(dialog).queryByText(/すべての友だちの既定メニューになります/)).toBeNull()
  })

  test('登録のみなら「出ません／表示先で操作」と言う', async () => {
    await openPublishConfirm(GROUP)
    const dialog = screen.getByRole('dialog', { name: '公開の確認' })
    expect(within(dialog).getByText(/この操作だけでは、友だちのトーク画面には出ません/)).toBeTruthy()
    expect(within(dialog).getByText(/一覧の「表示先」から操作してください/)).toBeTruthy()
  })
})

/*
 * R204残差: 公開step3の「いますぐ出す」の注記も設定別にする。
 * 全枝共通の「保存したらすぐ、条件に当てはまる人のトーク画面に出ます」は、
 * 条件あり（順次）・条件空（今0人）・登録のみ（登録だけ）と矛盾する。
 */
describe('R204 「いますぐ出す」の注記（設定に合わせた説明）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  async function renderPublish(group: typeof GROUP) {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: group }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
  }

  test('全員の既定なら「個別指定を除く全友だちにすぐ出る」と言う', async () => {
    await renderPublish({ ...GROUP, isDefaultForAll: true })
    expect(screen.getByTitle('保存したらすぐ、個別に指定した人を除くすべての友だちの既定メニューになります')).toBeTruthy()
    expect(screen.queryByText('保存したらすぐ、条件に当てはまる人のトーク画面に出ます')).toBeNull()
  })

  test('条件ありなら「出来事のタイミングで順次」と言い、すぐ出るとは言わない', async () => {
    await renderPublish({
      ...GROUP,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }),
    })
    expect(screen.getByTitle(/条件に当てはまる人の画面に出来事のタイミングで順次出ます/)).toBeTruthy()
    expect(screen.queryByText('保存したらすぐ、条件に当てはまる人のトーク画面に出ます')).toBeNull()
  })

  test('条件が空なら「今0人」と言う', async () => {
    await renderPublish({ ...GROUP, targetingEnabled: true, targetingCondition: null })
    expect(screen.getByTitle(/いまの条件では誰にも出ません（今0人）/)).toBeTruthy()
    expect(screen.queryByText('保存したらすぐ、条件に当てはまる人のトーク画面に出ます')).toBeNull()
  })

  test('登録のみなら「登録だけでは画面は変わらない」と言う', async () => {
    await renderPublish(GROUP)
    expect(screen.getByTitle(/LINEへの登録だけで、友だちの画面は変わりません/)).toBeTruthy()
    expect(screen.queryByText('保存したらすぐ、条件に当てはまる人のトーク画面に出ます')).toBeNull()
  })
})

/*
 * R204残差: 日時・期間の注記も自動表示を断定しない。どちらも指定時刻の
 * LINE登録予約であり、誰の画面に出るかは「公開すると何が変わるか」で決まる。
 * 期間を万能に安全とも言わない。新API・期間機能の追加はしない。
 */
describe('R204 日時・期間の注記（自動表示を断定しない）', () => {
  beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
  afterEach(() => { delete document.documentElement.dataset.theme })
  const SCHEDULED_NEW = '指定した時刻にLINEへ登録する予約です。誰の画面に出るかは「公開すると何が変わるか」で確認してください'
  const PERIOD_NEW = '指定した期間だけLINEに登録し、終わったら切り替えを予約します。誰の画面に出るかは「公開すると何が変わるか」で確認してください'
  const SCHEDULED_OLD = 'その時刻になったら自動で出ます。それまでは今のメニューのままです'
  const PERIOD_OLD = '終わったら自動で元に戻します。キャンペーンはこれが安全です'

  async function renderPublish(group: typeof GROUP) {
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: group }))
    searchParams.value = new URLSearchParams('id=grp-1&step=publish')
    render(<CurrentRichMenuEdit />)
    await flush()
    await screen.findByRole('heading', { name: 'いつ公開するか' })
  }

  async function expectReservationNotes(group: typeof GROUP) {
    await renderPublish(group)
    expect(screen.getByTitle(SCHEDULED_NEW)).toBeTruthy()
    expect(screen.getByTitle(PERIOD_NEW)).toBeTruthy()
    expect(screen.queryByText(SCHEDULED_OLD)).toBeNull()
    expect(screen.queryByText(PERIOD_OLD)).toBeNull()
  }

  test('登録のみでも日時・期間は「登録の予約」と言い、自動表示とは言わない', async () => {
    await expectReservationNotes(GROUP)
  })

  test('条件が空でも日時・期間は「登録の予約」と言い、自動表示とは言わない', async () => {
    await expectReservationNotes({ ...GROUP, targetingEnabled: true, targetingCondition: null })
  })

  test('条件ありでも日時・期間は「登録の予約」と言い、自動表示とは言わない', async () => {
    await expectReservationNotes({
      ...GROUP,
      targetingEnabled: true,
      targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }),
    })
  })
})

/*
 * R232: 複製に成功したのに確認窓が残ると、コピーの編集画面で
 * 「このコピーをさらに複製する？」に見えてしまう。成功時は窓を閉じ、
 * 失敗時は窓を開いたまま理由を出す。
 */
describe('複製の確認窓 (R232)', () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = 'v8'
    clearToastsForTest()
    richMenuGet.mockImplementation(() => Promise.resolve({ success: true, data: { ...GROUP, status: 'published' } }))
  })
  afterEach(() => { delete document.documentElement.dataset.theme; clearToastsForTest() })
  test('成功すると窓が閉じ、コピーの編集画面へ移る', async () => {
    searchParams.value = new URLSearchParams('id=grp-1')
    render(<><RichMenuDetailV8 groupId="grp-1" /><ToastHost /></>)
    await flush()
    await screen.findByRole('heading', { name: 'メインメニュー' })

    fireEvent.click(screen.getByRole('button', { name: 'そのほかの操作' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '複製する' }))
    await flush()
    expect(within(screen.getByRole('dialog', { name: /複製しますか/ })).getByRole('button', { name: '複製する' })).toBeTruthy()

    fireEvent.click(within(screen.getByRole('dialog', { name: /複製しますか/ })).getByRole('button', { name: '複製する' }))
    await flush()

    expect(richMenuDuplicate).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/rich-menus/edit?id=copy-1&step=shape')
    // 窓は閉じている。残ると「コピーをさらに複製する？」に見える。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /複製しますか/ })).toBeNull())
    expect(screen.getByText(/下書きを複製しました/)).toBeTruthy()
  })

  test('失敗したときは窓が開いたまま理由を出し、遷移しない', async () => {
    richMenuDuplicate.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'copy failed' }))
    searchParams.value = new URLSearchParams('id=grp-1')
    render(<><RichMenuDetailV8 groupId="grp-1" /><ToastHost /></>)
    await flush()
    await screen.findByRole('heading', { name: 'メインメニュー' })

    fireEvent.click(screen.getByRole('button', { name: 'そのほかの操作' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '複製する' }))
    await flush()
    fireEvent.click(within(screen.getByRole('dialog', { name: /複製しますか/ })).getByRole('button', { name: '複製する' }))
    await flush()

    expect(richMenuDuplicate).toHaveBeenCalledTimes(1)
    expect(routerPush).not.toHaveBeenCalled()
    expect(within(screen.getByRole('dialog', { name: /複製しますか/ })).getByRole('button', { name: '複製する' })).toBeTruthy()
    expect(screen.getByText('リッチメニューを複製できませんでした。もう一度お試しください。')).toBeTruthy()
    expect(screen.queryByText('copy failed')).toBeNull()
  })
})
