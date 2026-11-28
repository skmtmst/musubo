// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, within, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConversionsPage from '@/app/affiliates/page'
import EditPage from './edit/page'
const editNavigation = vi.hoisted(() => ({ query: '' }))

/*
 * N-252 #658: 成果地点を編集する導線を、本物のReactで確かめる。
 *
 * 見るのはソースの文字列ではなく、**画面から出たリクエスト**と**画面に出た文字**。
 * `api` / `fetchApi` は実物を通すので、URLの組み立ても応答の解釈も本番と同じ道になる。
 * 差し替えるのは通信・アカウント・タブだけ。
 */

const fixture = vi.hoisted(() => ({ accountId: 'account-a' as string | null }))
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  reviseStatus: 200 as number,
  reviseBody: null as unknown,
}))

vi.mock('next/link', () => ({ default: () => null }))
// N-264: 一覧は ?highlight= を読む。試験ではクエリ無しとして返す。
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(`tab=points&${editNavigation.query}`),
  useRouter: () => ({ replace: () => {}, push: (href: string) => { editNavigation.query = href.split('?')[1] ?? '' } }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => null,
  useMergedTab: () => 'points',
}))

const DEFINITION = {
  id: 'point-a',
  name: '購入',
  sourceType: 'ec_order_confirmed',
  value: 100,
  measureMethod: 'webhook',
  targetUrl: null,
  countRepeat: true,
  attributionDays: null,
  sourceConfig: {},
  deduplicationMode: 'every',
  deduplicationWindowDays: null,
  valueMode: 'fixed',
  reversalPolicy: 'manual',
  lineAccountId: 'account-a',
  status: 'active',
  state: 'active',
  stateReason: null,
  ingest: { configured: false, disabledAt: null },
  version: 3,
  usageCount: 1,
  usageNames: ['シナリオA'],
  metrics: {
    recordedCount: 5, netCount: 5, reversedCount: null, netValue: 500,
    reversalState: 'unavailable', reversalReason: '', cancellationCount: null, cancellationValue: null,
  },
  stoppedAt: null,
  createdAt: '2026-09-01T00:00:00.000+09:00',
  updatedAt: '2026-09-01T00:00:00.000+09:00',
}

function listBody() {
  return {
    success: true,
    data: {
      items: [DEFINITION],
      stateCounts: { active: 1, draft: 0, stopped: 0, invalid: 0, sourceStopped: 0, unused: 0 },
      range: { from: '2026-09-01 00:00:00', to: '2026-09-30 23:59:59', timeZone: 'Asia/Tokyo' },
      pagination: { total: 1, limit: 50, cursor: '0', nextCursor: null },
    },
  }
}

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body ?? null }
    net.calls.push({ path, method: init?.method ?? 'GET', body })

    if (/^\/api\/conversions\/definitions\/[^/]+\/revise/.test(path)) {
      return new Response(JSON.stringify(net.reviseBody ?? {
        success: true, data: { id: 'point-a', version: 4, revisionId: 'rev-1', movedUsages: 1, updatedAt: '' },
      }), { status: net.reviseStatus, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/staff/me')) return new Response(JSON.stringify({ success: true, data: { role: 'owner' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path.startsWith('/api/conversions/definitions')) {
      return new Response(JSON.stringify(listBody()), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (path.startsWith('/api/conversions/report') || path.startsWith('/api/conversions/definition-report')) {
      return new Response(JSON.stringify({ success: true, data: { kpis: {}, daily: [], byDefinition: [], byRoute: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

/** 非GETの送信は `getCsrfToken` が localStorage を読む。無いと送る前に落ちる。 */
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

let container: HTMLDivElement
let root: Root

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(React.createElement(ConversionsPage)) })
  await act(async () => { await Promise.resolve() })
}

/*
 * Dialog は `createPortal(overlay, document.body)` で描かれるので、
 * container の中だけを探すと窓の中身が見つからない。body 全体を見る。
 */
function byText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')]
    .find((node) => node.textContent?.trim() === text) as HTMLButtonElement | undefined
}

function byLabel(label: string): HTMLButtonElement | undefined {
  return document.body.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | undefined
}

function field(label: string): HTMLInputElement | HTMLSelectElement | undefined {
  return (document.body.querySelector(`[aria-label="${label}"]`) ?? undefined) as
    HTMLInputElement | HTMLSelectElement | undefined
}

async function click(node: HTMLElement | undefined) {
  expect(node, '押せる要素が見つかりません').toBeTruthy()
  await act(async () => { node!.click() })
  await act(async () => { await Promise.resolve() })
}

async function type(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 一覧から詳細を開き、編集の窓まで進める。詳細は行の「その他操作」メニューの中。 */
async function openEditDialog() {
  await click(byLabel('成果地点「購入」の操作'))
  await click(byText('成果地点の詳細を見る'))
  await click(byText('編集'))
  expect(editNavigation.query).toContain('id=')
  await act(async () => { root.render(React.createElement(EditPage)) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  editNavigation.query = ''
  net.calls = []
  net.reviseStatus = 200
  net.reviseBody = null
  fixture.accountId = 'account-a'
  vi.stubGlobal('localStorage', new MemoryStorage())
  installFetch()
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
})

describe('成果地点の編集（N-252）', () => {
  it('開いたときの版をそのまま送り、直した内容を口へ渡す', async () => {
    await mount()
    await openEditDialog()

    const name = field('成果地点の名前') as HTMLInputElement
    expect(name, '編集の窓が開いていません').toBeTruthy()
    // 開いた時点で、いまの設定が入っている。
    expect(name.value).toBe('購入')
    expect((field('1件あたりの金額') as HTMLInputElement).value).toBe('100')

    await type(name, '購入（改）')
    await type(field('1件あたりの金額') as HTMLInputElement, '500')
    await click(byText('この内容にする'))

    const revise = net.calls.find((call) => call.path.includes('/revise'))
    expect(revise, '編集の口が呼ばれていません').toBeTruthy()
    expect(revise!.method).toBe('POST')
    expect(revise!.body).toMatchObject({
      // **開いたときの版**。送る直前に取り直さない（取り直すと他人の変更を消す）。
      expectedVersion: 3,
      name: '購入（改）',
      valueMode: 'fixed',
      fixedValue: 500,
    })
  })

  it('ほかの人が先に直していたら、上書きせずに読み直しを促す', async () => {
    net.reviseStatus = 409
    net.reviseBody = { success: false, error: '成果地点が更新されています。読み直してください' }
    await mount()
    await openEditDialog()
    await click(byText('この内容にする'))

    expect(document.body.textContent).toContain('上書きしていません')
    // 窓は開いたまま。閉じて「保存できた」と誤解させない。
    expect(field('成果地点の名前')).toBeTruthy()
    // 勝手に送り直さない。
    expect(net.calls.filter((call) => call.path.includes('/revise'))).toHaveLength(1)
  })

  /*
   * 口が 200 のまま `success: false` を返す形。`fetchApi` は 4xx では投げるが、
   * 200 は投げないので、`res.success` を見ていないと「保存できた」ように見える。
   */
  it('200 のまま success:false が返っても、保存できたことにしない', async () => {
    net.reviseStatus = 200
    net.reviseBody = { success: false, error: '成果地点を編集できませんでした' }
    await mount()
    await openEditDialog()
    await click(byText('この内容にする'))

    // 窓は開いたまま。理由も出る。
    expect(field('成果地点の名前')).toBeTruthy()
    expect(document.body.textContent).toContain('成果地点を編集できませんでした')
  })

  it('名前を空にしたまま送らない', async () => {
    await mount()
    await openEditDialog()
    await type(field('成果地点の名前') as HTMLInputElement, '   ')
    await click(byText('この内容にする'))
    expect(net.calls.filter((call) => call.path.includes('/revise'))).toHaveLength(0)
    expect(document.body.textContent).toContain('名前を入れてください')
  })

describe('編集も起点に合う金額の決め方にする', () => {
  const TAG_SOURCE = {
    ...DEFINITION,
    id: 'point-tag',
    name: 'タグ付け',
    sourceType: 'tag_added',
    valueMode: 'source',
    value: 200,
    deduplicationMode: 'once_per_friend',
  }
  const ORDER_SOURCE = {
    ...DEFINITION,
    id: 'point-order',
    name: '注文',
    sourceType: 'ec_order_confirmed',
    valueMode: 'source',
    value: null,
  }

  /** 一覧の口が返す成果地点を差し替える。版上げの口は成功のまま。 */
  function stubList(items: unknown[]) {
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : String(input)
      const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
      let body: unknown = null
      try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body ?? null }
      net.calls.push({ path, method: init?.method ?? 'GET', body })
      if (/^\/api\/conversions\/definitions\/[^/]+\/revise/.test(path)) {
        return new Response(JSON.stringify(net.reviseBody ?? {
          success: true, data: { id: 'point-x', version: 4, revisionId: 'rev-1', movedUsages: 1, updatedAt: '' },
        }), { status: net.reviseStatus, headers: { 'Content-Type': 'application/json' } })
      }
      if (path.startsWith('/api/staff/me')) return new Response(JSON.stringify({ success: true, data: { role: 'owner' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path.startsWith('/api/conversions/definitions')) {
        return new Response(JSON.stringify({ ...listBody(), data: { ...listBody().data, items } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (path.startsWith('/api/conversions/report') || path.startsWith('/api/conversions/definition-report')) {
        return new Response(JSON.stringify({ success: true, data: { kpis: {}, daily: [], byDefinition: [], byRoute: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  async function openEditDialogFor(name: string) {
    await click(byLabel(`成果地点「${name}」の操作`))
    await click(byText('成果地点の詳細を見る'))
    await click(byText('編集'))
  expect(editNavigation.query).toContain('id=')
  await act(async () => { root.render(React.createElement(EditPage)) })
  await act(async () => { await Promise.resolve() })
  }

  /** 金額の決め方欄の知らせ。窓が開いていないときは落ちる。 */
  function amountNotice(): string | null {
    const trigger = byLabel('金額の決め方')
    expect(trigger, '編集の窓が開いていません').toBeTruthy()
    return trigger!.closest('[data-label-size]')?.querySelector('[role="status"]')?.textContent ?? null
  }

  /** 金額の決め方の候補を開いて文字を全部読む。 */
  async function openOptions(): Promise<string> {
    await click(byLabel('金額の決め方'))
    return [...document.body.querySelectorAll('li[role="option"]')]
      .map((node) => node.textContent ?? '').join('')
  }

  it('起点に合わない決め方は開いたときに既定へ戻して知らせ、注文の金額は出さない', async () => {
    stubList([TAG_SOURCE])
    await mount()
    await openEditDialogFor('タグ付け')
    // 昔の版に残っていた注文の金額は、合う既定(金額を数えない)へ戻る。
    expect(byLabel('金額の決め方')?.textContent).toContain('金額を数えない')
    expect(amountNotice()).toContain('金額の決め方を')
    expect(amountNotice()).toContain('戻しました')
    // 候補に連携元の金額は出ない。
    expect(await openOptions()).not.toContain('連携元の金額を使う')
    // 閉じて保存すると既定が送られる。
    await click(byLabel('金額の決め方'))
    await click(byText('この内容にする'))
    const revise = net.calls.find((call) => call.path.includes('/revise'))
    expect(revise, '編集の口が呼ばれていません').toBeTruthy()
    expect(revise!.body).toMatchObject({ valueMode: 'none', fixedValue: null })
  })

  it('注文起点の注文の金額はそのまま残り、知らせも出ない', async () => {
    stubList([ORDER_SOURCE])
    await mount()
    await openEditDialogFor('注文')
    expect(byLabel('金額の決め方')?.textContent).toContain('連携元の金額を使う')
    expect(amountNotice()).toBeNull()
    expect(await openOptions()).toContain('連携元の金額を使う')
  })
})

describe('S4-OR 編集の数えない条件は空のかたまりを黙って落とさない', () => {
  /** 編集の窓の中の or 追加ボタン。作成と同じ共通部品。 */
  function orAddButton(): HTMLElement | undefined {
    return [...document.body.querySelectorAll('button')]
      .find((node) => node.getAttribute('aria-label') === 'いずれか条件のかたまりを足す')
  }

  /** 編集の窓の中の条件の足し口。最初は1つ、or 追加で2つ。 */
  function kindPickers(): HTMLElement[] {
    return [...document.body.querySelectorAll('button')]
      .filter((node) => node.getAttribute('aria-label') === '追加する条件を選択する')
  }

  async function pickKind(field: HTMLElement, query: string) {
    await click(field)
    const dialog = screen.getByRole('dialog', { name: '条件を選ぶ', hidden: true })
    await click(within(dialog).getByRole('radio', { name: query, hidden: true }))
    await click(within(dialog).getByRole('button', { name: '条件を足す', hidden: true }))
  }

  it('空の or かたまりのまま決めると案内が出て、版上げの口は呼ばれない', async () => {
    await mount()
    await openEditDialog()
    expect(kindPickers()).toHaveLength(1)
    await click(orAddButton())
    expect(kindPickers()).toHaveLength(2)
    await click(byText('この内容にする'))

    expect(document.body.textContent).toContain('空の「いずれか」の条件のかたまりがあります')
    expect(net.calls.filter((call) => call.path.includes('/revise'))).toHaveLength(0)
    // 窓は開いたまま。下書きも残る。
    expect(kindPickers()).toHaveLength(2)
  })

  it('かたまりに条件を入れると決められ、除外として送られる', async () => {
    await mount()
    await openEditDialog()
    await click(orAddButton())
    await pickKind(kindPickers()[1], '行動スコア')
    /* 編集の窓は数えない条件の人数を出さないので、条件を入れても数え上げの口は呼ばない。 */
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)) })
    expect(net.calls.filter((call) => call.path.includes('/segments'))).toHaveLength(0)
    await click(byText('この内容にする'))

    const revise = net.calls.find((call) => call.path.includes('/revise'))
    expect(revise, '編集の口が呼ばれていません').toBeTruthy()
    const exclusion = (revise!.body as { sourceConfig: { exclusion: {
      groups: Array<{ rules: Array<{ type: string }> }> } | null } }).sourceConfig.exclusion
    expect(exclusion?.groups).toHaveLength(1)
    expect(exclusion?.groups?.[0].rules[0].type).toBe('score_range')
  })
})

describe('停止済み成果地点の編集導線', () => {
  it('停止済みの成果地点には編集の導線を出さない', async () => {
    const stopped = { ...DEFINITION, status: 'stopped', stoppedAt: '2026-09-02T00:00:00.000+09:00' }
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : String(input)
      const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
      net.calls.push({ path, method: init?.method ?? 'GET', body: null })
      if (path.startsWith('/api/staff/me')) return new Response(JSON.stringify({ success: true, data: { role: 'owner' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path.startsWith('/api/conversions/definitions')) {
        return new Response(JSON.stringify({ ...listBody(), data: { ...listBody().data, items: [stopped] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: { kpis: {}, daily: [], byDefinition: [], byRoute: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await mount()
    await click(byLabel('成果地点「購入」の操作'))
    await click(byText('成果地点の詳細を見る'))
    // 詳細は開いている（この判定が空振りしないことを先に確かめる）。
    // UI-25: 「閉じる」は右上の×（aria-label）へ移った。
    expect(byLabel('閉じる')).toBeTruthy()
    expect(byText('編集')).toBeUndefined()
  })
})
})
