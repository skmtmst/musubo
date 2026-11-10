// @vitest-environment happy-dom
import React, { act } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #989 (NEXT-16〜19/24): テンプレート作成画面の「表示と保存値の食い違い」
 * 回帰試験。実Reactで操作→保存API呼出を観る。
 *
 * - NEXT-17: クーポンの回数・公開対象・抽選・期間が選択どおり保存される。
 * - NEXT-18: リッチメッセージは選んだ形状の面数だけ設定欄と tapAreas ができる。
 * - NEXT-19: リサーチの質問は配列で、順序・形式・必須・選択肢まで保存される。
 * - NEXT-24: 「自分に送って確かめる」は未対応と分かる形で出る（無反応でない）。
 */
const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  createCalls: [] as Array<{ lineAccountId: string; kind: string; name: string; payload: Record<string, unknown> }>,
}))

const emptyList = () => Promise.resolve({ success: true, data: [] })

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, accounts: [{ id: 'account-a', name: 'A' }, { id: 'account-b', name: 'B' }], loading: false }),
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の保存値の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))
vi.mock('@/lib/api', () => ({
  api: {
    folders: { list: emptyList },
    broadcastMessageAssets: {
      folders: { list: emptyList },
      create: (input: { lineAccountId: string; kind: string; name: string; payload: Record<string, unknown> }) => {
        fixture.createCalls.push(input)
        return Promise.resolve({ success: true, data: { id: 'asset-1' } })
      },
    },
    media: {
      list: () => Promise.resolve({ success: true, data: { items: [], total: 0, limit: 20, offset: 0 } }),
      contentUrl: (id: string, accountId: string) => `/api/media/${id}/content?accountId=${accountId}`,
    },
    // InlineActionList / useActionOptions が読む候補。
    tags: { list: emptyList },
    friendFields: { list: emptyList },
    supportMarks: { list: emptyList },
    scenarios: { list: emptyList },
    commonVars: { list: emptyList },
    featureSettings: { visibility: () => Promise.resolve({ success: true, data: { features: {} } }) },
  },
}))

const { default: TemplateRichEditor } = await import('@/v8/template-edit/rich')
const { default: TemplateAssetEditorV8 } = await import('@/v8/template-edit/asset')
function TemplateAssetEditor({ kind }: { kind: 'rich_message' | 'coupon' | 'research' }) {
  return kind === 'rich_message' ? <TemplateRichEditor /> : <TemplateAssetEditorV8 kind={kind} />
}

let host: HTMLDivElement
let root: Root

async function settle() {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function renderEditor(kind: 'rich_message' | 'coupon' | 'research') {
  await act(async () => {
    root.render(<TemplateAssetEditor kind={kind} />)
    await settle()
  })
}

function buttonByText(text: string, scope: ParentNode = host): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`ボタンがありません: ${text}`)
  return button
}

function buttonContaining(text: string, scope: ParentNode = host): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`ボタンがありません: ${text}`)
  return button
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function input(selector: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`入力欄がありません: ${selector}`)
  return el
}

const WEEK = '日月火水木金土'

/** 日時の選択（★管理画面）で YYYY-MM-DDTHH:mm を選ぶ。値は今までどおり日本時間の文字列。 */
async function setDateTime(label: string, iso: string) {
  const [date, time] = iso.split('T')
  const [hour, minute] = time.split(':')
  const [y, mo, d] = date.split('-').map(Number)
  const week = WEEK[new Date(y, mo - 1, d).getDay()]
  await act(async () => {
    document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!.click()
    await settle()
  })
  const picker = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
  for (let i = 0; i < 24; i += 1) {
    const grid = document.querySelector('[role="grid"]')
    const currentLabel = /^(\d+)年(\d+)月$/.exec(grid?.getAttribute('aria-label') ?? '')
    const current = currentLabel ? Number(currentLabel[1]) * 12 + Number(currentLabel[2]) : y * 12 + mo
    if (grid?.getAttribute('aria-label') === `${y}年${mo}月`) break
    const nav = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === (y * 12 + mo >= current ? '次の月' : '前の月'),
    )!
    await act(async () => {
      nav.click()
      await settle()
    })
  }
  await act(async () => {
    Array.from(document.querySelectorAll('button')).find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith(`${y}年${mo}月${d}日（${week}）`),
    )!.click()
    await settle()
  })
  const reopened = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
  await setTimeControl(reopened.querySelector('input[role="combobox"]'), `${hour}:${minute}`)
  await act(async () => {
    const close = Array.from(reopened.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!
    close.click()
    await settle()
  })
}
import { setTimeControl } from '@/test-utils/time-control'

function selectByLabel(label: string): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!el) throw new Error(`選択欄がありません: ${label}`)
  return el
}

/** 名前を入れて保存する。 */
async function nameAndSave() {
  const nameInput = document.querySelector<HTMLInputElement>('input[type="text"]')!
  await act(async () => {
    setInputValue(nameInput, '監査用テンプレート')
    const title = document.getElementById('te-coupon-title') as HTMLInputElement | null
    const amount = document.getElementById('te-coupon-amount') as HTMLInputElement | null
    if (title) setInputValue(title, '監査用クーポン')
    if (amount) setInputValue(amount, '500')
    await settle()
  })
  await act(async () => {
    buttonByText('下書きを保存').click()
    await settle()
  })
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.createCalls.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})


describe('NEXT-17: クーポンの設定が保存値へ入る', () => {
  it('回数・公開対象・期間・抽選なしを選ぶと、その値だけが保存される', async () => {
    await renderEditor('coupon')
    await setDateTime('使える期間の開始', '2026-10-01T09:00')
    await setDateTime('使える期間の終了', '2026-10-31T23:59')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '期間中なら何回でも' }))
      expect(screen.queryByRole('button', { name: 'リンクを知っている人' })).toBeNull()
    })
    expect(screen.queryByRole('spinbutton', { name: /当たる確率/ })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: /当選人数/ })).toBeNull()
    await nameAndSave()
    expect(fixture.createCalls).toHaveLength(1)
    const payload = fixture.createCalls[0].payload
    expect(payload).toMatchObject({ startsAt: '2026-10-01T09:00', endsAt: '2026-10-31T23:59', oncePerFriend: false, visibility: 'friends', lottery: false })
    expect(payload).not.toHaveProperty('lotteryRate')
    expect(payload).not.toHaveProperty('winnerLimit')
  })
  it('保存済みの抽選は無断で公開せず、条件なしへの明示変更を促す', async () => {
    const onSave = vi.fn()
    const payload = { title: '昔の抽選券', description: 'ご案内', lottery: true, lotteryRate: 35, winnerLimit: 120, startsAt: '2026-10-01T09:00', endsAt: '2026-11-30T23:59' }
    await act(async () => {
      root.render(<TemplateAssetEditorV8 kind="coupon" host={{ description: '', folders: [], folder: '', onFolderChange: () => {}, busy: false, onSave, onCancel: () => {}, initialContent: { kind: 'coupon', name: '昔の券', payload } }} />)
      await settle()
    })
    await act(async () => { buttonByText('保存する').click(); await settle() })
    expect(onSave).not.toHaveBeenCalled()
    expect(host.textContent).toContain('抽選には対応していません。条件なしへ変更してください')
    expect(payload).toMatchObject({ lottery: true, lotteryRate: 35, winnerLimit: 120 })
  })
  it('期間が未入力だと保存せず理由を出す', async () => {
    await renderEditor('coupon')
    await nameAndSave()
    expect(fixture.createCalls).toHaveLength(0)
    expect(host.textContent).toContain('開始を入力してください')
    expect(host.textContent).toContain('終了を入力してください')
  })
})

const areaList = () => screen.getByRole('list', { name: '面の一覧' })
const chooseShape = async (name: RegExp) => { await act(async () => { fireEvent.click(screen.getByRole('radio', { name })) }) }
const chooseArea = async (letter: string) => { await act(async () => { fireEvent.click(screen.getByLabelText(new RegExp('^面 ' + letter + '「'))) }) }

describe('NEXT-18: リッチメッセージの面数と保存値が一致する', () => {
  it('6面を選ぶと6面分の設定を選べて、tapAreasも6件になる', async () => {
    await renderEditor('rich_message')
    await chooseShape(/^6面/)
    expect(within(areaList()).getAllByRole('button')).toHaveLength(6)
    expect(within(areaList()).getAllByText('未設定')).toHaveLength(6)
    await chooseArea('A')
    await act(async () => {
      setSelectValue(selectByLabel('面 A を押したら'), 'uri')
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('面 A のURL'), { target: { value: 'https://example.com/campaign' } })
      fireEvent.change(screen.getByLabelText('画像のURL'), { target: { value: 'https://cdn.example.test/rich.png' } })
    })
    await nameAndSave()
    expect(fixture.createCalls).toHaveLength(1)
    expect(fixture.createCalls[0]).toMatchObject({ lineAccountId: 'account-a', kind: 'rich_message' })
    const payload = fixture.createCalls[0].payload
    expect(payload.shape).toBe('6')
    const tapAreas = payload.tapAreas as Array<Record<string, unknown>>
    expect(tapAreas.map(area => area.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    expect(tapAreas[0]).toMatchObject({ actionType: 'uri', uri: 'https://example.com/campaign' })
    expect(tapAreas[5]).toMatchObject({ actionType: 'none' })
    for (const area of tapAreas) { expect(typeof area.x).toBe('number'); expect(typeof area.width).toBe('number') }
  })
  it('設定済みの面を消す形へ変えるときは確認し、承認すると設定が消える', async () => {
    await renderEditor('rich_message')
    await chooseArea('C')
    await act(async () => { setSelectValue(selectByLabel('面 C を押したら'), 'uri') })
    await act(async () => { fireEvent.change(screen.getByLabelText('面 C のURL'), { target: { value: 'https://example.com/c' } }) })
    await chooseShape(/^左右2面/)
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.textContent).toContain('C')
    expect(within(areaList()).getAllByRole('button')).toHaveLength(3)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '変える' })); await settle() })
    expect(within(areaList()).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByLabelText('面 C のURL')).toBeNull()
    await act(async () => { fireEvent.change(screen.getByLabelText('画像のURL'), { target: { value: 'https://cdn.example.test/rich.png' } }) })
    await nameAndSave()
    const tapAreas = fixture.createCalls[0].payload.tapAreas as Array<Record<string, unknown>>
    expect(tapAreas.map(area => area.label)).toEqual(['A', 'B'])
  })
})

const questionSection = (number: number) => host.querySelector<HTMLElement>('section[aria-label="問 ' + number + '"]')!
describe('NEXT-19: リサーチの質問が保存値へ入る', () => {
  it('質問の追加・本文・形式・必須・選択肢が保存され、順序も保つ', async () => {
    await renderEditor('research')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '質問を足す' })) })
    expect(host.querySelectorAll('section[aria-label^="問 "]')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '問 2 を消す' }).querySelector('svg.lucide-trash-2')).toBeTruthy()
    await act(async () => {
      fireEvent.change(within(questionSection(2)).getByRole('textbox', { name: /質問文/ }), { target: { value: 'よく使っている商品を教えてください' } })
      setSelectValue(selectByLabel('問 2 の答え方'), 'multiple')
      fireEvent.click(screen.getByRole('switch', { name: '問 2 を必ず答えてもらう' }))
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('問 2 の選択肢 1'), { target: { value: 'フード' } })
      fireEvent.change(screen.getByLabelText('問 2 の選択肢 2'), { target: { value: 'おやつ' } })
      fireEvent.change(within(questionSection(1)).getByRole('textbox', { name: /質問文/ }), { target: { value: '来月も定期便を続けたいと思いますか？' } })
      fireEvent.change(screen.getByLabelText('問 1 の選択肢 1'), { target: { value: '続けたい' } })
      fireEvent.change(screen.getByLabelText('問 1 の選択肢 2'), { target: { value: '止めたい' } })
    })
    await nameAndSave()
    expect(fixture.createCalls).toHaveLength(1)
    const payload = fixture.createCalls[0].payload
    expect(payload.questionCount).toBe(2)
    expect(payload.questions).toEqual([
      { text: '来月も定期便を続けたいと思いますか？', format: 'single', required: true, choices: ['続けたい', '止めたい'], choiceTapExtras: [{}, {}] },
      { text: 'よく使っている商品を教えてください', format: 'multiple', required: false, choices: ['フード', 'おやつ'], choiceTapExtras: [{}, {}] },
    ])
  })
  it('質問を消すと一覧・件数・保存値が揃う', async () => {
    await renderEditor('research')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '質問を足す' })) })
    expect(host.querySelectorAll('section[aria-label^="問 "]')).toHaveLength(2)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '問 2 を消す' })) })
    expect(host.querySelectorAll('section[aria-label^="問 "]')).toHaveLength(1)
    await act(async () => {
      fireEvent.change(within(questionSection(1)).getByRole('textbox', { name: /質問文/ }), { target: { value: '続けますか？' } })
      fireEvent.change(screen.getByLabelText('問 1 の選択肢 1'), { target: { value: 'はい' } })
    })
    await nameAndSave()
    expect(fixture.createCalls[0].payload.questionCount).toBe(1)
    expect(fixture.createCalls[0].payload.questions).toHaveLength(1)
  })
})

describe('NEXT-24: 未対応の自分への送信を操作にしない', () => {
  it.each(['rich_message', 'coupon', 'research'] as const)('%s: 操作を出さず理由を確認できる', async kind => {
    await renderEditor(kind)
    expect(screen.queryByRole('button', { name: '自分に送って確かめる' })).toBeNull()
    expect(screen.getByTitle(/一斉配信に組み込むと、配信の画面からテスト送信できます/)).toBeTruthy()
    expect(fixture.createCalls).toEqual([])
  })
})
