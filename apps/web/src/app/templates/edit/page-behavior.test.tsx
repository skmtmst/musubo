/*
 * テンプレート編集の実操作試験。
 *
 * **Required gate（`pnpm --filter web test`）から動く。** 外に立てた
 * 画面サーバーやブラウザを当てにすると、gate では一度も走らないまま
 * 「試験あり」と読まれる。ここは画面が実際に使っている関数と部品を
 * そのまま呼び、ログインの取り扱いも含めて1つのファイルで完結させる。
 *
 * 見張っているのは4つ。
 *   1. ログイン（未ログインは401、権限外のアカウントは403）
 *   2. アカウントの境界（A のテンプレートへ B の候補を保存させない）
 *   3. 逆順に届いた応答（古い応答で新しい表示を上書きしない）
 *   4. 日数の見本（過ぎた日を負の数で見せない）
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 差し込み口の機能連動は共通hookへ寄せたので、この試験では「全部on」を
 * 固定で返す。オフの振る舞いは common-vars-feature-gate.test.tsx が見る。
 */
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({
    status: 'ready',
    features: { friend_fields: true, common_vars: true },
    enabled: () => true,
  }),
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後のテンプレートの判断なので、素の <select> に置き換える。
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

type PageModule = typeof import('./page')
type Testing = PageModule['default']['__testing']

let T: Testing
let SESSION_LOST_EVENT: string
let ADMIN_SESSION_STORAGE_KEY: string
let CSRF_STORAGE_KEY: string

const API = 'https://worker.example.com'
const SESSION = 'session-token-for-test'
const CSRF = 'csrf-token-for-test'

/** 画面と同じ順番で読み込む。`@/lib/api` は先に API の宛先を要求する。 */
beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_URL = API
  ;({ ADMIN_SESSION_STORAGE_KEY } = await import('@/lib/admin-session'))
  ;({ SESSION_LOST_EVENT, CSRF_STORAGE_KEY } = await import('@/lib/api'))
  const page = (await import('./page')) as PageModule
  T = page.default.__testing
})

/* ---------------------------------------------------------------- 実データ */

type Account = 'account-a' | 'account-b'

const FIELDS: Record<Account, Array<{ key: string; name: string; value: string }>> = {
  'account-a': [{ key: 'a_pet', name: 'A店のペット名', value: 'ココ' }],
  'account-b': [{ key: 'b_plan', name: 'B店のコース', value: '月4回' }],
}

const VARS: Record<Account, Array<{ key: string; name: string; value: string }>> = {
  'account-a': [{ key: 'a_hours', name: 'A店の営業時間', value: '10時〜18時' }],
  'account-b': [{ key: 'b_hours', name: 'B店の営業時間', value: '9時〜21時' }],
}

const friendField = (accountId: Account, index = 0) => ({
  id: `${accountId}-field-${index}`,
  folderId: null,
  name: FIELDS[accountId][index].name,
  fieldKey: FIELDS[accountId][index].key,
  type: 'text',
  options: null,
  defaultValue: FIELDS[accountId][index].value,
  source: 'manual',
  ecFieldPath: null,
  ecIsMaster: false,
  isPersonal: false,
  isStarred: false,
  displayOrder: 0,
  canInsertText: true,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
})

const commonVar = (accountId: Account, index = 0) => ({
  id: `${accountId}-var-${index}`,
  lineAccountId: accountId,
  folderId: null,
  name: VARS[accountId][index].name,
  varKey: VARS[accountId][index].key,
  type: 'text',
  value: VARS[accountId][index].value,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
})

/* ------------------------------------------------- ログインを持つ偽のAPI */

interface Session {
  /** ログインしていない状態を作るための切り替え。 */
  signedIn: boolean
  /** この職員が触れるアカウント。ここに無いものは 403。 */
  allowed: Account[]
}

const sessionState: Session = { signedIn: true, allowed: ['account-a', 'account-b'] }

/** 実際に走った通信。どの口へ、どの方法で、何を送ったか。 */
const calls: Array<{ method: string; path: string; body: unknown; auth: string | null; csrf: string | null }> = []
const sessionLost = vi.fn()

/** 節ごとに差し替える、遅らせたい応答。 */
let delays: Map<string, Promise<void>> = new Map()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function fakeApi(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  const headers = new Headers(init?.headers as HeadersInit | undefined)
  const method = (init?.method ?? 'GET').toUpperCase()
  const auth = headers.get('Authorization')
  const csrf = headers.get('X-CSRF-Token')
  calls.push({
    method,
    path: `${url.pathname}${url.search}`,
    body: init?.body ? JSON.parse(String(init.body)) : null,
    auth,
    csrf,
  })

  // ログインが届いていない。画面は1か所で受けるので、ここでの合図も見る。
  if (!sessionState.signedIn || auth !== `Bearer lh_session:${SESSION}`) {
    return jsonResponse({ success: false, error: 'unauthorized' }, 401)
  }
  // 書き込む口は、画面が持っている合言葉が無ければ受け付けない。
  if (method !== 'GET' && csrf !== CSRF) {
    return jsonResponse({ success: false, error: 'csrf' }, 403)
  }

  const accountId = (url.searchParams.get('lineAccountId') ?? url.searchParams.get('accountId')) as Account | null
  const wait = accountId ? delays.get(`${url.pathname}:${accountId}`) : undefined
  if (wait) await wait

  if (url.pathname === '/api/friend-fields' || url.pathname === '/api/common-vars') {
    if (!accountId) return jsonResponse({ success: false, error: 'accountId required' }, 400)
    // 触れないアカウントを問い合わせたら、中身ではなく権限で断る。
    if (!sessionState.allowed.includes(accountId)) {
      return jsonResponse({ success: false, error: 'forbidden' }, 403)
    }
    return jsonResponse({
      success: true,
      data: url.pathname === '/api/friend-fields' ? [friendField(accountId)] : [commonVar(accountId)],
    })
  }

  if (url.pathname.startsWith('/api/templates')) {
    return jsonResponse({ success: true, data: { id: 'existing', name: '保存済み' } })
  }

  return jsonResponse({ success: false, error: 'not found' }, 404)
}

beforeEach(() => {
  calls.length = 0
  sessionLost.mockClear()
  delays = new Map()
  sessionState.signedIn = true
  sessionState.allowed = ['account-a', 'account-b']

  /*
   * 画面と同じ置き場。ログインの跡は sessionStorage、合言葉は localStorage。
   * ここを用意しないと `adminSessionHeaders` が空を返し、認証を通らない
   * ことが「試験の都合」なのか「実装の欠陥」なのか見分けられない。
   */
  const store = (initial: Record<string, string>) => {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    }
  }
  vi.stubGlobal('sessionStorage', store({ [ADMIN_SESSION_STORAGE_KEY]: SESSION }))
  vi.stubGlobal('localStorage', store({ [CSRF_STORAGE_KEY]: CSRF, lh_staff_role: 'owner' }))
  vi.stubGlobal('window', {
    dispatchEvent: (event: Event) => {
      if (event.type === SESSION_LOST_EVENT) sessionLost()
      return true
    },
  })
  vi.stubGlobal('fetch', vi.fn(fakeApi))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const binding = (overrides: Partial<Parameters<Testing['resolveEditorAccountId']>[0]> = {}) => ({
  templateId: 'template-a',
  templateStatus: 'ready' as const,
  templateAccountId: 'account-a',
  selectedAccountId: 'account-a',
  ...overrides,
})

const saveInput = (overrides: Partial<Parameters<Testing['validateTemplateSave']>[0]> = {}) => ({
  ...binding(),
  name: '初回のご案内',
  category: 'general',
  messageType: 'text',
  messageContent: '{{field.a_pet}} をよろしくお願いします',
  folderId: null,
  ...overrides,
})

/* ------------------------------------------------------------------ 認証 */

describe('ログインの取り扱い', () => {
  it('ログインしていないと候補を1つも出さず、セッション切れの合図を出す', async () => {
    sessionState.signedIn = false

    await expect(T.loadTemplateReferences('account-a')).rejects.toBeTruthy()
    expect(sessionLost).toHaveBeenCalled()
    expect(calls.every((call) => call.path.startsWith('/api/friend-fields') || call.path.startsWith('/api/common-vars')))
      .toBe(true)
  })

  it('ログイン済みなら、実際の口へセッションを付けて問い合わせる', async () => {
    const references = await T.loadTemplateReferences('account-a')

    expect(references.friendFields.map((field) => field.fieldKey)).toEqual(['a_pet'])
    expect(references.commonVars.map((item) => item.varKey)).toEqual(['a_hours'])
    expect(calls.map((call) => call.path).sort()).toEqual([
      '/api/common-vars?accountId=account-a',
      '/api/friend-fields?lineAccountId=account-a',
    ])
    expect(calls.every((call) => call.auth === `Bearer lh_session:${SESSION}`)).toBe(true)
    expect(sessionLost).not.toHaveBeenCalled()
  })

  it('触れないアカウントの候補は権限で断られ、読み込み失敗として扱う', async () => {
    sessionState.allowed = ['account-a']

    const result = await T.requestTemplateReferences({
      load: T.loadTemplateReferences,
      accountId: 'account-b',
      generation: 1,
      currentGeneration: () => 1,
    })

    expect(result).toBe('failed')
    // 403 は「ログインが届いていない」ではない。合図を出すと原因を取り違える。
    expect(sessionLost).not.toHaveBeenCalled()
  })
})

/* -------------------------------------------------------- アカウント境界 */

describe('既存テンプレートの所属アカウント', () => {
  it('上のバーを B へ替えても、A のテンプレートの候補は A のまま', async () => {
    const editorAccountId = T.resolveEditorAccountId(binding({ selectedAccountId: 'account-b' }))
    expect(editorAccountId).toBe('account-a')

    const references = await T.loadTemplateReferences(editorAccountId as string)
    expect(references.friendFields.map((field) => field.fieldKey)).toEqual(['a_pet'])
    expect(references.commonVars.map((item) => item.varKey)).toEqual(['a_hours'])
  })

  it('取得が終わるまでは、どちらの候補も読みにいかない', () => {
    expect(T.resolveEditorAccountId(binding({ templateStatus: 'loading', selectedAccountId: 'account-b' }))).toBeNull()
  })

  it('新規作成は、上のバーで選んでいるアカウントで読む', () => {
    expect(T.resolveEditorAccountId(binding({ templateId: null, templateAccountId: null, selectedAccountId: 'account-b' })))
      .toBe('account-b')
  })

  it('所属を持たない旧データは、選んでいるアカウントで編集できる', () => {
    const legacy = binding({ templateAccountId: null, selectedAccountId: 'account-b' })
    expect(T.resolveEditorAccountId(legacy)).toBe('account-b')
    expect(T.templateAccountMismatch(legacy)).toBe(false)
  })

  it('食い違いを見分ける', () => {
    expect(T.templateAccountMismatch(binding())).toBe(false)
    expect(T.templateAccountMismatch(binding({ selectedAccountId: 'account-b' }))).toBe(true)
    expect(T.templateAccountMismatch(binding({ templateStatus: 'loading', selectedAccountId: 'account-b' }))).toBe(false)
    expect(T.templateAccountMismatch(binding({ selectedAccountId: null }))).toBe(false)
  })
})

describe('食い違ったまま保存させない', () => {
  it('B を選んだまま A のテンプレートを保存しようとすると、APIを呼ばずに断る', async () => {
    const input = saveInput({
      selectedAccountId: 'account-b',
      messageContent: '{{field.b_plan}} をよろしくお願いします',
    })

    expect(T.validateTemplateSave(input)).toBe(T.ACCOUNT_MISMATCH_MESSAGE)

    const result = await T.saveTemplateEdit(input)
    expect(result).toEqual({ ok: false, error: T.ACCOUNT_MISMATCH_MESSAGE })
    // 断ったのに通信していたら、サーバー側には B の項目が書き込まれている。
    expect(calls).toHaveLength(0)
  })

  it('所属と選択が揃っていれば、いつもどおり保存する', async () => {
    const result = await T.saveTemplateEdit(saveInput())

    // 成功時も id を返す（「保存して公開」が直後に公開APIへ渡すため）。
    expect(result).toEqual({ ok: true, id: 'existing' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].path).toBe('/api/templates/template-a')
    expect(calls[0].csrf).toBe(CSRF)
    expect(calls[0].body).toMatchObject({ name: '初回のご案内', messageContent: '{{field.a_pet}} をよろしくお願いします' })
  })

  it('読み込めなかったテンプレートは、空の本文で上書きしない', async () => {
    const result = await T.saveTemplateEdit(saveInput({ templateStatus: 'failed', messageContent: '' }))

    expect(result).toEqual({ ok: false, error: T.TEMPLATE_LOAD_FAILED_MESSAGE })
    expect(calls).toHaveLength(0)
  })

  it('新規はアカウントを選ぶまで保存しない', async () => {
    const result = await T.saveTemplateEdit(saveInput({
      templateId: null,
      templateAccountId: null,
      selectedAccountId: null,
    }))

    expect(result).toEqual({ ok: false, error: '上のバーでLINE公式アカウントを選んでください' })
    expect(calls).toHaveLength(0)
  })

  it('取得が終わっていないテンプレートへは、APIを呼ばずに断る', async () => {
    for (const status of ['idle', 'loading'] as const) {
      const input = saveInput({ templateStatus: status })
      expect(T.templateSaveGuard(input)).toBe(T.TEMPLATE_LOADING_MESSAGE)
      expect(T.validateTemplateSave(input)).toBe(T.TEMPLATE_LOADING_MESSAGE)
      await expect(T.saveTemplateEdit(input))
        .resolves.toEqual({ ok: false, error: T.TEMPLATE_LOADING_MESSAGE })
    }
    // 送り先だけ新しい id、中身は前のまま——という組み合わせを一度も通さない。
    expect(calls).toHaveLength(0)
  })

  it('新規作成は取得を待たない', () => {
    const input = saveInput({ templateId: null, templateStatus: 'idle', templateAccountId: null })
    expect(T.templateSaveGuard(input)).toBeNull()
  })

  it('名前と本文が空のまま保存しない', () => {
    expect(T.validateTemplateSave(saveInput({ name: '   ' }))).toBe('名前を入力してください')
    expect(T.validateTemplateSave(saveInput({ messageContent: '  ' }))).toBe('本文を入力してください')
  })

  it('R249: カード型に通常文・壊れたJSON・型なしJSONを保存しない', async () => {
    for (const messageContent of ['初回のお届け予定はこちらです', '{壊れている', '{}']) {
      const input = saveInput({ messageType: 'flex', messageContent })
      expect(T.validateTemplateSave(input)).toContain('カードの内容')
      const result = await T.saveTemplateEdit(input)
      expect(result.ok).toBe(false)
    }
  })

  it('R249: 正常なカードは保存できる', () => {
    const input = saveInput({
      messageType: 'flex',
      messageContent: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}',
    })
    expect(T.validateTemplateSave(input)).toBeNull()
  })
})

/* ------------------------------------------------------------ 逆順の応答 */

describe('遅れて届いた応答', () => {
  it('A への問い合わせが B より後に返っても、B の候補を上書きしない', async () => {
    const slowA = deferred()
    delays.set('/api/friend-fields:account-a', slowA.promise)
    delays.set('/api/common-vars:account-a', slowA.promise)

    let generation = 0
    const currentGeneration = () => generation

    const firstGeneration = ++generation
    const first = T.requestTemplateReferences({
      load: T.loadTemplateReferences,
      accountId: 'account-a',
      generation: firstGeneration,
      currentGeneration,
    })

    const secondGeneration = ++generation
    const second = await T.requestTemplateReferences({
      load: T.loadTemplateReferences,
      accountId: 'account-b',
      generation: secondGeneration,
      currentGeneration,
    })

    expect(second).not.toBeNull()
    expect(second).not.toBe('failed')
    expect((second as { friendFields: Array<{ fieldKey: string }> }).friendFields.map((f) => f.fieldKey))
      .toEqual(['b_plan'])

    slowA.release()
    // 後から返った A は捨てる。返してしまうと画面が A の候補へ戻る。
    await expect(first).resolves.toBeNull()
  })

  it('遅れて届いた失敗も、新しい表示を失敗にしない', async () => {
    sessionState.allowed = ['account-b']
    const slowA = deferred()
    delays.set('/api/friend-fields:account-a', slowA.promise)
    delays.set('/api/common-vars:account-a', slowA.promise)

    let generation = 0
    const currentGeneration = () => generation

    const staleGeneration = ++generation
    const stale = T.requestTemplateReferences({
      load: T.loadTemplateReferences,
      accountId: 'account-a',
      generation: staleGeneration,
      currentGeneration,
    })

    const freshGeneration = ++generation
    const fresh = await T.requestTemplateReferences({
      load: T.loadTemplateReferences,
      accountId: 'account-b',
      generation: freshGeneration,
      currentGeneration,
    })
    expect(fresh).not.toBe('failed')

    slowA.release()
    await expect(stale).resolves.toBeNull()
  })
})

/* -------------------------------------------------------------- 日数の見本 */

describe('目標日までの日数の見本', () => {
  const delivered = new Date('2026-09-09T03:00:00.000Z') // JST 2026-09-09 12:00

  it('先の日付は残り日数を出す', () => {
    expect(T.previewDateValue('days_until:2026-09-30', delivered)).toBe('21')
    expect(T.previewDateValue('days_until:2026-09-10', delivered)).toBe('1')
  })

  it('当日と過ぎた日は 0。実際の配信と同じ数にする', () => {
    expect(T.previewDateValue('days_until:2026-09-09', delivered)).toBe('0')
    expect(T.previewDateValue('days_until:2026-09-01', delivered)).toBe('0')
    expect(T.previewDateValue('days_until:2025-01-01', delivered)).toBe('0')
  })

  it('本文の見本にも負の数が出ない', () => {
    const preview = T.buildTemplatePreview(
      'あと{{days_until:2026-09-01}}日です',
      { friendFields: [], commonVars: [] },
      delivered,
    )
    expect(preview.content).toBe('あと0日です')
    expect(preview.content).not.toContain('-')
    expect(preview.unresolved).toEqual([])
  })

  it('D007: 本文が無くても見本づくりは落ちず、空を返す', () => {
    for (const content of [undefined, null] as unknown[]) {
      expect(() =>
        T.buildTemplatePreview(content as string, { friendFields: [], commonVars: [] }),
      ).not.toThrow()
      expect(
        T.buildTemplatePreview(content as string, { friendFields: [], commonVars: [] }),
      ).toEqual({ content: '', unresolved: [] })
      expect(T.extractMessageUrls(content as string)).toEqual([])
    }
  })

  it('D007: 形の違う詳細応答は中身として受け取らない', () => {
    // 一覧形・空・本文なしは ready にしない。
    expect(T.isTemplateDetailData({ items: [] })).toBe(false)
    expect(T.isTemplateDetailData(null)).toBe(false)
    expect(T.isTemplateDetailData(undefined)).toBe(false)
    expect(T.isTemplateDetailData({ name: '案内', messageType: 'text' })).toBe(false)
    expect(T.isTemplateDetailData({ name: '案内', messageType: 'text', messageContent: 42 })).toBe(false)
    // 利用先が物でないものも受け取らない。
    expect(T.isTemplateDetailData({ name: '案内', messageType: 'text', messageContent: '本文', usedBy: '壊れた値' })).toBe(false)
    // 型どおりは受け取る。利用先が無くてもよい。
    expect(T.isTemplateDetailData({ name: '案内', messageType: 'text', messageContent: '本文' })).toBe(true)
    expect(T.isTemplateDetailData({ name: '案内', messageType: 'text', messageContent: '本文', usedBy: null })).toBe(true)
  })
})

/* ------------------------------------------------------- 見本の置き換え */

describe('差し込み後の見え方', () => {
  it('実データの既定値と現在値で置き換え、値の無いものは残して知らせる', async () => {
    const references = await T.loadTemplateReferences('account-a')
    const preview = T.buildTemplatePreview(
      '{{name}}さん {{field.a_pet}} {{var.a_hours}} {{field.b_plan}}',
      references,
      new Date('2026-09-09T03:00:00.000Z'),
    )

    expect(preview.content).toBe('見本 141さん ココ 10時〜18時 {{field.b_plan}}')
    // B の項目は A のテンプレートでは置き換わらない。そのまま相手へ届く。
    expect(preview.unresolved).toEqual(['field.b_plan'])
  })
})

/* -------------------------------------------------------------- 画面の描画 */

describe('画面に出る言葉', () => {
  it('食い違っているときだけ、戻し方を添えて知らせる', () => {
    const quiet = renderToStaticMarkup(
      <T.TemplateAccountNotice binding={binding()} templateAccountLabel="A店" selectedAccountLabel="A店" />,
    )
    expect(quiet).toBe('')

    const alert = renderToStaticMarkup(
      <T.TemplateAccountNotice
        binding={binding({ selectedAccountId: 'account-b' })}
        templateAccountLabel="A店"
        selectedAccountLabel="B店"
      />,
    )
    expect(alert).toContain(T.ACCOUNT_MISMATCH_MESSAGE)
    expect(alert).toContain('このテンプレートは「A店」のものです')
    expect(alert).toContain('いま選んでいるのは「B店」です')
    expect(alert).toContain('差し込み候補は「A店」のまま出しています')
    expect(alert).toContain('role="alert"')
  })

  it('固定しているアカウントの名前を、候補の下に出す', () => {
    const controls = insertControls({ accountLabel: 'A店' })

    expect(allText(controls)).toContain('候補は「A店」の友だち情報と共通情報です。')
    expect(optionsOf(controls, '友だち情報を差し込む').map((option) => option.label))
      .toEqual(['友だち情報を選ぶ', 'A店のペット名'])
    expect(allText(controls)).not.toContain('B店のコース')
  })

  it('読み込めなかったときは、候補を選ばせない', () => {
    const controls = insertControls({ state: 'failed', friendFields: [], commonVars: [] })

    expect(allText(controls)).toContain('差し込み項目を読み込めませんでした。画面を再読み込みしてください。')
    for (const label of ['友だち情報を差し込む', '共通情報を差し込む']) {
      const select = findElement(controls, (element) =>
        (element.props as { 'aria-label'?: string })['aria-label'] === label)
      expect((select?.props as { disabled: boolean }).disabled).toBe(true)
    }
  })

  it('アカウントを選ぶ前は、選び方を案内する', () => {
    const controls = insertControls({ accountId: null, state: 'idle', friendFields: [], commonVars: [] })

    expect(allText(controls)).toContain('LINE公式アカウントを選ぶと、友だち情報と共通情報を選べます。')
  })
})

/* ------------------------------------------------------------ 実際の操作 */

describe('差し込みボタンの押下', () => {
  it('「名前」を押すと、本文へ渡す文字が {{name}} になる', () => {
    const inserted: string[] = []
    const controls = insertControls({ onInsert: (token: string) => inserted.push(token) })

    const nameButton = findElement(controls, (element) =>
      childText(element) === '名前' && typeof (element.props as { onClick?: unknown }).onClick === 'function')
    expect(nameButton).toBeDefined()
    ;(nameButton?.props as { onClick: () => void }).onClick()

    expect(inserted).toEqual(['{{name}}'])
  })

  it('候補を選ぶと、そのアカウントの項目キーだけが入る', () => {
    const inserted: string[] = []
    const controls = insertControls({ onInsert: (token: string) => inserted.push(token) })

    expect(optionsOf(controls, '友だち情報を差し込む').map((option) => option.value))
      .toEqual(['', '{{field.a_pet}}'])
    const select = findElement(controls, (element) =>
      (element.props as { 'aria-label'?: string })['aria-label'] === '友だち情報を差し込む')
    // 共通 Select の onChange は値そのものを受け取る（イベントではない）。
    ;(select?.props as { onChange: (value: string) => void })
      .onChange('{{field.a_pet}}')

    expect(inserted).toEqual(['{{field.a_pet}}'])
  })
})

/**
 * 差し込みの並びを、画面と同じ引数で組み立てる。
 *
 * `renderToStaticMarkup` は使わない。この並びは共通の `Select` を
 * 含み、その部品は自動JSXで書かれているため、試験の変換では文字列に
 * できない。**組み立てた木をそのまま見るほうが、渡した値まで分かる。**
 */
function insertControls(overrides: Record<string, unknown> = {}): React.ReactElement {
  return T.TemplateInsertControls({
    accountId: 'account-a',
    state: 'ready',
    targetDate: '',
    onTargetDateChange: vi.fn(),
    friendFields: [friendField('account-a')],
    commonVars: [commonVar('account-a')],
    onInsert: vi.fn(),
    ...overrides,
  } as never) as React.ReactElement
}

function optionsOf(node: React.ReactNode, label: string): Array<{ value: string; label: string }> {
  const select = findElement(node, (element) =>
    (element.props as { 'aria-label'?: string })['aria-label'] === label)
  return (select?.props as { options: Array<{ value: string; label: string }> }).options
}

/** 木の中の文字をすべて集める。表示する言葉を1本の文字列で見張る。 */
function allText(node: React.ReactNode): string {
  const parts: string[] = []
  for (const child of React.Children.toArray(node)) {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child))
      continue
    }
    if (!React.isValidElement(child)) continue
    const props = child.props as { children?: React.ReactNode; options?: Array<{ label: string }> }
    for (const option of props.options ?? []) parts.push(option.label)
    parts.push(allText(props.children))
  }
  return parts.join('')
}

/* React の木をたどる。DOM が無くても、実際に組み立てられた部品を見られる。 */
function findElement(
  node: React.ReactNode,
  match: (element: React.ReactElement) => boolean,
): React.ReactElement | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue
    if (match(child)) return child
    const found = findElement((child.props as { children?: React.ReactNode }).children, match)
    if (found) return found
  }
  return undefined
}

function childText(element: React.ReactElement): string {
  return React.Children.toArray((element.props as { children?: React.ReactNode }).children)
    .filter((child) => typeof child === 'string')
    .join('')
    .trim()
}
