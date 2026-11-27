// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
/*
 * カルーセル保存の失敗まわりを、実際に mount して確かめる（N-149）。
 *
 * 見張る筋書きは Issue の完了条件そのもの。
 *
 *   1. 作成の2段階目（postback の id 埋め直し）で失敗しても、
 *      入力した内容は画面に残り、原因と「もう一度保存する」が出る
 *   2. 再試行は新規作成ではなく、作成済みテンプレートへの更新になる
 *      （再試行のたびにテンプレートが増えない）
 *   3. 409（ほかの人が先に公開した）でも同じ。下書きは残る
 *   4. 連打しても保存は1回だけ走る
 *
 * あわせて、画面が使っている保存関数 saveCarousel を直接呼んで、
 * 通信の順番と id の持ち回りを試験する。
 *
 * 差し替えるのは通信（api.templates など）と遷移（next/navigation,
 * next/link）だけ。画面の判断は差し替えない。
 */
import React, { act } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* `@/lib/api` は読み込んだ時点で API の宛先を要求する。 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://worker.example.com'
})

/* --------------------------------------------------- 画面まわりの置き換え */

const routing = vi.hoisted(() => ({
  params: new URLSearchParams(),
  pushed: [] as string[],
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({
    push: (href: string) => routing.pushed.push(href),
    replace: (href: string) => routing.pushed.push(href),
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => routing.params,
  usePathname: () => '/templates/carousel',
}))

/* Link は行き先を出すだけの部品。画面の判断とは関わらない。 */
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

/*
 * 画面は「上のバー」で選んだアカウントを読む。ここでは A店 に固定する。
 * AccountProvider 本体は /api/line-accounts を読みにいくので文脈ごと差し替え、
 * 通信の前提なしに画面を組み立てられるようにする。
 */
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: [{ id: 'account-a', name: 'A店' }],
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: 'A店' },
    setSelectedAccountId: () => {},
    clearSelectedAccountId: () => {},
    refreshAccounts: async () => {},
    loading: false,
  }),
}))

/*
 * 選択肢の中身編集はこの試験の筋書きと関係ない。機能のon/offだけ
 * 「全部on」に固定し、候補取得の通信を待たないようにする。
 */
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({
    status: 'ready',
    features: { friend_fields: true, common_vars: true },
    enabled: () => true,
  }),
}))

/* ------------------------------------------------------------ 通信の偽物 */

/*
 * api 本体は実物のまま、テンプレートと周辺の取得だけ差し替える。
 * create / update の呼ばれた回数と中身がこの試験の本体。
 */
const calls = vi.hoisted(() => ({
  templatesGet: vi.fn(),
  templatesCreate: vi.fn(),
  templatesUpdate: vi.fn(),
  foldersList: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const empty = async () => ({ success: true as const, data: [] as never[] })
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: calls.foldersList },
      tags: { ...actual.api.tags, list: empty },
      friendFields: { ...actual.api.friendFields, list: empty },
      supportMarks: { ...actual.api.supportMarks, list: empty },
      scenarios: { ...actual.api.scenarios, list: empty },
      commonVars: { ...actual.api.commonVars, list: empty },
      templates: {
        ...actual.api.templates,
        get: calls.templatesGet,
        create: calls.templatesCreate,
        update: calls.templatesUpdate,
      },
    },
  }
})

import CarouselEditorPage from './page'

const Testing = CarouselEditorPage.__testing

/* -------------------------------------------------------------- 組み立て */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mountAt(search: string) {
  routing.params = new URLSearchParams(search)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(React.createElement(CarouselEditorPage)) })
  await settle()
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function all(tag: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(tag)) as HTMLElement[]
}

/** 見出しや札の文字で1つ選ぶ。運用の人が画面で読む言葉で探す。 */
function byText(tag: string, text: string): HTMLElement | null {
  return all(tag).find((element) => element.textContent?.trim() === text) ?? null
}

const saveButton = () => byText('button', '下書きを保存')
const retryButton = () => screenText().includes('入力した内容はそのまま残っています') ? saveButton() : null
const nameInput = () => document.getElementById('cr-name-input') as HTMLInputElement | null
const screenText = () => container.textContent ?? ''

/** 入力の欄へ、画面と同じく入力の出来事で入れる。 */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function typeName(value: string) {
  typeInto(nameInput()!, value)
  typeInto(document.getElementById('cr-text') as HTMLInputElement, '案内の本文')
  typeInto(choiceLabelInput()!, '詳しく見る')
  const uri = container.querySelector<HTMLInputElement>('input[placeholder="例：https://example.com"]')
  if (uri) typeInto(uri, 'https://example.com')
}

/** 選択肢の「ボタンの文字」の欄。 */
const choiceLabelInput = () =>
  container.querySelector('input[placeholder="ボタンの文字"]') as HTMLInputElement | null

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const okCreate = () => Promise.resolve({ success: true as const, data: { id: 'tpl-new', name: '保存済み' } })
const okUpdate = () => Promise.resolve({ success: true as const, data: { id: 'tpl-new' } })

it('新規カルーセルは下の帯に未保存の状態を出す', async () => {
  await mountAt('')
  expect(container.querySelector('[data-template-region="footer"]')?.textContent).toContain('下書きはまだ保存していません')
})

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  routing.pushed = []
  calls.templatesGet.mockReset()
  calls.templatesCreate.mockReset()
  calls.templatesUpdate.mockReset()
  calls.foldersList.mockReset()
  calls.foldersList.mockResolvedValue({ success: true, data: [] })
  calls.templatesCreate.mockImplementation(okCreate)
  calls.templatesUpdate.mockImplementation(okUpdate)
  calls.templatesGet.mockResolvedValue({
    success: true,
    data: {
      id: 'tmpl-1',
      accountId: 'account-a',
      name: '既存のカルーセル',
      category: 'カルーセル',
      messageType: 'carousel',
      messageContent: JSON.stringify([
        { title: 'パネル1', text: '既存の本文', actions: [{ type: 'uri', label: '見る', uri: 'https://example.com' }] },
      ]),
      folderId: null,
      question: null,
      questionStatus: 'draft',
      carouselActions: null,
      carouselTapLimitMode: 'none',
      carouselTapLimitText: null,
      usedBy: {
        autoReplies: [], automations: [], scenarioSteps: [],
        reminderSteps: [], richMenuAreas: [], trackedLinks: [],
      },
      hasDraft: false,
      publishedVersion: 1,
      publishedAt: '2026-09-01T00:00:00.000Z',
      draftRevision: 0,
      createdAt: '',
      updatedAt: '',
    },
  })
  /*
   * 画面は staff かどうかを localStorage の役割で見る（owner は保存できる）。
   * 試験環境の localStorage は空なので、役割だけを持つ器を置く。
   */
  const store = new Map<string, string>([['lh_staff_role', 'owner']])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

/* ================================================================ 筋書き */

describe('N-149: 保存に失敗しても下書きを保持して再試行できる', () => {
  it('2段階目の失敗で原因と再試行を出し、再試行は作成済みテンプレートへの更新になる', async () => {
    /*
     * 「押されたときに何かする」があると postback になり、id が要るので
     * 保存は 作成 → 埋め直し更新 の2段階になる。その2段階目だけ失敗させる。
     */
    calls.templatesUpdate
      .mockRejectedValueOnce(new Error('サーバーで保存できませんでした'))
      .mockImplementation(okUpdate)

    await mountAt('')
    await act(async () => { typeName('新しいカルーセル') })
    await act(async () => {
      // ボタンの文字を入れて「押されたときに何かする」へ替えると postback
      // になり、保存は2段階になる。
      typeInto(choiceLabelInput()!, '詳しく見る')
      fireEvent.click(screen.getByLabelText('カード1のボタン1の動き'))
    })
    await settle()
    await act(async () => { fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: '動きを実行する' }).querySelector('button')!) })
    await settle()

    await act(async () => { click(saveButton()!) })
    await settle()

    // --- 1. 原因と再試行の口が出て、入力はそのまま残っている。
    expect(screenText()).toContain('サーバーで保存できませんでした')
    expect(screenText()).toContain('入力した内容はそのまま残っています')
    expect(retryButton()).not.toBeNull()
    expect(nameInput()!.value).toBe('新しいカルーセル')
    expect(routing.pushed).toEqual([])

    // ここまでで 作成1回・更新1回。増えていないことを後で確かめる。
    expect(calls.templatesCreate).toHaveBeenCalledTimes(1)
    expect(calls.templatesUpdate).toHaveBeenCalledTimes(1)

    // --- 2. もう一度保存すると、新規作成ではなく作成済み id への更新になる。
    await act(async () => { click(retryButton()!) })
    await settle()

    expect(calls.templatesCreate).toHaveBeenCalledTimes(1)
    expect(calls.templatesUpdate).toHaveBeenCalledTimes(2)
    // やり直しの更新には、名前も id 入りの本文も全部入る。
    const [retryId, retryPayload] = calls.templatesUpdate.mock.calls[1]
    expect(retryId).toBe('tpl-new')
    expect(retryPayload).toMatchObject({ name: '新しいカルーセル', messageType: 'carousel' })
    expect(String(retryPayload.messageContent)).toContain('ctpl=tpl-new')
    // 成功してはじめて一覧へ進む。
    expect(routing.pushed[0]).toMatch(/^\/templates(?:\?|$)/)
  })

  it('409 が返っても下書きは残り、再試行で保存できる', async () => {
    calls.templatesUpdate
      .mockRejectedValueOnce(new Error('編集中に公開状態が変わりました。読み直してください'))
      .mockImplementation(okUpdate)

    await mountAt('?id=tmpl-1')
    expect(nameInput()!.value).toBe('既存のカルーセル')

    await act(async () => { click(saveButton()!) })
    await settle()

    expect(screenText()).toContain('編集中に公開状態が変わりました。読み直してください')
    expect(nameInput()!.value).toBe('既存のカルーセル')
    expect(routing.pushed).toEqual([])

    await act(async () => { click(retryButton()!) })
    await settle()

    expect(calls.templatesUpdate).toHaveBeenCalledTimes(2)
    expect(calls.templatesUpdate.mock.calls[1][0]).toBe('tmpl-1')
    expect(routing.pushed).toEqual([])
  })

  it('保存中にもう一度押しても、通信は1回しか出ない', async () => {
    const pending = deferred()
    calls.templatesCreate.mockImplementation(async () => {
      await pending.promise
      return { success: true as const, data: { id: 'tpl-new' } }
    })

    await mountAt('')
    await act(async () => { typeName('連打テスト') })

    // 応答を止めたまま2回押す。2回目は「保存中」の旗で弾かれる。
    await act(async () => {
      click(saveButton()!)
      click(saveButton()!)
    })

    expect(calls.templatesCreate).toHaveBeenCalledTimes(1)
    expect(calls.templatesUpdate).not.toHaveBeenCalled()

    pending.release()
    await settle()
    expect(calls.templatesCreate).toHaveBeenCalledTimes(1)
    expect(routing.pushed).toEqual(['/templates?highlight=tpl-new'])
  })

  it('入力の不備で止まったときは、再試行の口を出さない', async () => {
    await mountAt('')

    await act(async () => { click(saveButton()!) })
    await settle()

    expect(screenText()).toContain('名前を入力してください')
    expect(retryButton()).toBeNull()
    expect(calls.templatesCreate).not.toHaveBeenCalled()
    expect(calls.templatesUpdate).not.toHaveBeenCalled()
  })
})

/* ----------------------------------------------------- 保存関数の直接試験 */

describe('saveCarousel', () => {
  const baseInput = {
    templateId: null,
    selectedAccountId: 'account-a',
    name: 'カルーセル',
    panels: [
      {
        thumbnailImageUrl: '',
        title: 'パネル1',
        text: '本文',
        actions: [{ label: '押す', kind: 'action' as const, uri: '', actions: [] }],
      },
    ],
    folderId: null,
    tapLimitMode: 'none' as const,
    tapLimitText: '',
  }

  it('作成が済んで埋め直しが失敗したら、作成済み id を返す', async () => {
    const create = vi.fn(() => okCreate())
    const update = vi.fn(() =>
      Promise.resolve({ success: false as const, error: '後段が失敗' }))

    const result = await Testing.saveCarousel(baseInput, { create, update } as never)

    expect(result).toEqual({ ok: false, error: '後段が失敗', createdId: 'tpl-new' })
    expect(create).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('埋め直しが通信エラー（例外）でも、作成済み id を返す', async () => {
    const create = vi.fn(() => okCreate())
    const update = vi.fn(() => Promise.reject(new Error('network down')))

    const result = await Testing.saveCarousel(baseInput, { create, update } as never)

    expect(result).toEqual({ ok: false, error: '保存に失敗しました。時間をおいて、もう一度お試しください。', createdId: 'tpl-new' })
  })

  it('作成済み id を渡した再試行は、作成せず更新だけを送る', async () => {
    const create = vi.fn()
    const update = vi.fn(() => okUpdate())

    const result = await Testing.saveCarousel(
      { ...baseInput, templateId: 'tpl-new' },
      { create, update } as never,
    )

    // 成功時も id を返す（「保存して公開」が直後に公開APIへ渡すため）。
    expect(result).toEqual({ ok: true, id: 'tpl-new' })
    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledTimes(1)
    // id が決まっているので、postback の data は最初から正しい。
    const payload = update.mock.calls[0][1] as { messageContent: string }
    expect(payload.messageContent).toContain('ctpl=tpl-new')
  })

  it('作成そのものが失敗したら、作成済み id は返さない', async () => {
    const create = vi.fn(() =>
      Promise.resolve({ success: false as const, error: '作成できません' }))
    const update = vi.fn()

    const result = await Testing.saveCarousel(baseInput, { create, update } as never)

    expect(result).toEqual({ ok: false, error: '作成できません' })
    expect(update).not.toHaveBeenCalled()
  })

  it('「押されたときに何かする」が無ければ、埋め直しの更新を送らない', async () => {
    const create = vi.fn(() => okCreate())
    const update = vi.fn()

    const result = await Testing.saveCarousel(
      {
        ...baseInput,
        panels: [
          {
            thumbnailImageUrl: '',
            title: 'パネル1',
            text: '本文',
            actions: [{ label: '見る', kind: 'uri' as const, uri: 'https://example.com', actions: [] }],
          },
        ],
      },
      { create, update } as never,
    )

    expect(result).toEqual({ ok: true, id: 'tpl-new' })
    expect(update).not.toHaveBeenCalled()
  })
})

describe('カルーセルを作る：枚数・ボタン・見え方・フォルダ・読み込めないとき', () => {
  it('カードは10枚まで。10枚になると足す・複製を押せず、理由を title で読める', async () => {
    await mountAt('')
    const add = () => byText('button', 'カードを足す') as HTMLButtonElement
    for (let i = 0; i < 9; i += 1) await act(async () => { click(add()) })
    expect(screenText()).toContain('10 / 10 枚')
    expect(add().disabled).toBe(true)
    const duplicate = byText('button', 'このカードを複製') as HTMLButtonElement
    expect(duplicate.disabled).toBe(true)
    expect(duplicate.title).toBe('カードは10 枚までです')
  })

  it('ボタンは1枚に3つまで。3つになると足せず、理由を title で読める', async () => {
    await mountAt('')
    expect(screenText()).toContain('ボタン（最大 3 つ）')
    const add = () => byText('button', 'ボタンを足す') as HTMLButtonElement
    await act(async () => { click(add()) })
    expect(add().disabled).toBe(false)
    await act(async () => { click(add()) })
    expect(add().disabled).toBe(true)
    expect(add().title).toBe('ボタンは3つまでです。')
    expect(container.querySelectorAll('input[placeholder="ボタンの文字"]')).toHaveLength(3)
  })

  it('画像の大きさの目安を出し、入れたタイトルを右のLINEの見え方に映す', async () => {
    await mountAt('')
    expect(container.querySelector('[title^="画像は横1024 × 縦678pxを推奨"]')).not.toBeNull()
    await act(async () => { typeInto(document.getElementById('cr-title') as HTMLInputElement, '秋の定期便') })
    const phone = container.querySelector('[data-line-preview-part="phone"]')
    expect(phone?.textContent).toContain('秋の定期便')
  })

  it('フォルダを選んで保存すると、選んだフォルダの番号を送る', async () => {
    calls.foldersList.mockResolvedValue({ success: true, data: [{ id: 'fol-autumn', kind: 'template', name: '秋の案内', itemCount: 0 }] })
    await mountAt('')
    expect(calls.foldersList).toHaveBeenCalledWith('template', 'account-a')
    await act(async () => { typeName('秋のカルーセル') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ' })) })
    const option = await screen.findByRole('option', { name: /秋の案内/ })
    await act(async () => { fireEvent.click(within(option).getByRole('button')) })
    await act(async () => { click(saveButton()!) })
    await settle()
    expect(calls.templatesCreate).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'fol-autumn' }))
  })

  it('既存のカルーセルを読み込めないときは理由を出し、保存の口を押せない形にする', async () => {
    calls.templatesGet.mockRejectedValueOnce(new Error('network'))
    await mountAt('id=tmpl-1')
    expect(screenText()).toContain('読み込めませんでした。もう一度お試しください。')
    expect((byText('button', '下書きを保存') as HTMLButtonElement).disabled).toBe(true)
    expect((byText('button', '保存して公開') as HTMLButtonElement).disabled).toBe(true)
    expect(calls.templatesUpdate).not.toHaveBeenCalled()

    const retryLoad = byText('button', 'もう一度読み込む')
    expect(retryLoad).not.toBeNull()
    await act(async () => { click(retryLoad!) })
    await settle()
    expect(calls.templatesGet).toHaveBeenCalledTimes(2)
    expect(screenText()).not.toContain('読み込めませんでした。もう一度お試しください。')
    expect(nameInput()!.value).toBe('既存のカルーセル')
    expect((byText('button', '下書きを保存') as HTMLButtonElement).disabled).toBe(false)
    expect((byText('button', '保存して公開') as HTMLButtonElement).disabled).toBe(false)
    expect(calls.templatesUpdate).not.toHaveBeenCalled()
  })
})
