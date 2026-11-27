import { describeApiFailure } from '@/components/shared/api-error-message'
import type { TapExtras } from '@line-crm/shared'
/*
 * 現役の画面と動作試験で使う組み立て/保存の正本。
 * 見本（?visual=1）は絵  の3枚。ボタンの「押したら」（絵 JkLOF・2026-10-08 オーナー）：
 * URL を開く・動きを実行するに、テキストを送る・回答フォーム・予約ページ・予約履歴を開くを足した。
 */
import { api } from '@/lib/api'
import { toActionPayload, type InlineAction } from '@/components/auto-replies/draft-fields'
import { tapActionDef, tapActionFromUri, tapExtraSaveError, tapActionLiffUrl, tapActionNeedsLiff, type LiffTapActionKind } from '@/lib/tap-actions'

export const MAX_COLUMNS = 10
export const MAX_ACTIONS = 3
export const TITLE_MAX = 40
export const TEXT_MAX_WITH_IMAGE = 60
export const TEXT_MAX_WITHOUT_IMAGE = 120

/** ボタン1つの「押したら」。6つ（lib/tap-actions.ts）と、店だけの「動きを実行する」（action）。 */
export type ChoiceKind = 'uri' | 'message' | 'form' | 'booking' | 'booking_history' | 'visit_stamp' | 'action'

/*
 * LINE のテンプレートのボタン（message アクション）で送れる文の長さ。
 * LINE Messaging API の決まり（template message の message action の text は 300 文字まで）。
 */
export const MESSAGE_TEXT_MAX = 300

/** 選択肢1つぶん。 */
export interface Choice {
  tapExtras?: TapExtras
  label: string
  /**
   * 'uri'（URLを開く）・'message'（テキストを送る）・'form'（回答フォームを開く）・
   * 'booking'（予約ページを開く）・'booking_history'（予約履歴を開く）・'action'（押されたときに何かする）。
   * 'visit_stamp'（来店スタンプを開く）。
   * form・booking・booking_history・visit_stamp は LINE では uri のボタン（このアカウントの LIFF の URL）になる。
   */
  kind: ChoiceKind
  uri: string
  /** kind='message' のときに送る文。 */
  text: string
  /**
   * 開く作ってあるもの：kind='form' は回答フォーム（必須）、'booking' は予約メニュー（任意）、
   * 'visit_stamp' はスタンプカード（任意）の ID。共通の欄（TapActionField）の refId。
   */
  formId: string
  /** kind='action' のときに実行する並び。 */
  actions: InlineAction[]
}

/*
 * LIFF のページの URL・読み戻しは lib/tap-actions.ts の1か所（Codex の packages/shared の関数ができたらそこで差し替える）。
 * 店のカルーセルは、保存するときにそのアカウントの LIFF ID を入れて作る
 * （{{liff_id}} は一斉配信でしか置き換わらず、シナリオ・自動応答・受信箱などでは置き換わらないため）。
 */
export function liffPageUrl(liffId: string, kind: LiffTapActionKind, formId = ''): string {
  return tapActionLiffUrl(liffId, kind, formId)
}

/** 保存してある uri のボタンが LIFF のどのページか（読み戻し用）。当たらなければ 'uri'。 */
export function choiceFromUri(uri: string): Pick<Choice, 'kind' | 'formId'> {
  const parsed = tapActionFromUri(uri)
  return { kind: parsed.kind as ChoiceKind, formId: parsed.refId }
}

/** LIFF のページを開く動き（アカウントに LIFF が無いと作れない）。 */
export function needsLiff(kind: ChoiceKind): kind is LiffTapActionKind {
  return tapActionNeedsLiff(kind)
}

export interface Panel {
  thumbnailImageUrl: string
  title: string
  text: string
  actions: Choice[]
}

export function emptyChoice(): Choice {
  return { label: '', kind: 'uri', uri: '', text: '', formId: '', actions: [] }
}

export function emptyPanel(): Panel {
  return { thumbnailImageUrl: '', title: '', text: '', actions: [emptyChoice()] }
}

export function visualPanels(): Panel[] {
  return [
    {
      thumbnailImageUrl: '',
      title: '夏の定番セット（送料込み）',
      text: 'この夏いちばん出ているセットです。8月末まで送料無料。',
      actions: [
        { label: 'このセットを見る', kind: 'uri' as const, uri: 'https://nen.example/set', text: '', formId: '', actions: [] },
        { label: '詳しく見る', kind: 'action' as const, uri: '', text: '', formId: '', actions: [] },
      ],
    },
    { thumbnailImageUrl: '', title: '定期便', text: '毎月おなじものが届きます。いつでも止められます。', actions: [{ label: '詳しく見る', kind: 'uri' as const, uri: 'https://nen.example/regular', text: '', formId: '', actions: [] }] },
    { thumbnailImageUrl: '', title: 'おやつ', text: '小さなおやつの詰め合わせです。', actions: [{ label: '詳しく見る', kind: 'uri' as const, uri: 'https://nen.example/snack', text: '', formId: '', actions: [] }] },
  ]
}

/*
 * 選択肢の中身を組み立てる。
 *
 * 「押されたときに何かする」を選んだ選択肢は postback になる。data には
 * どのテンプレートのどの選択肢かを入れる。**テンプレートの id は、新規作成の
 * ときまだ決まっていない**ので、いったん空で作り、id が返ってから埋めて
 * 保存し直す（saveCarousel の2段階目）。
 */
export function buildCarouselContent(panels: Panel[], templateId: string, liffId: string | null = null): string {
  return JSON.stringify(
    panels.map((p, ci) => ({
      ...(p.thumbnailImageUrl.trim() ? { thumbnailImageUrl: p.thumbnailImageUrl.trim() } : {}),
      ...(p.title.trim() ? { title: p.title.trim() } : {}),
      text: p.text.trim(),
      actions: p.actions
        .filter((a) => a.label.trim())
        .map((a, ai) => ({ ...buildChoiceAction(a, `ctpl=${templateId}&c=${ci}&a=${ai}`, liffId), ...(a.tapExtras ? { tapExtras: a.tapExtras } : {}) })),
    })),
  )
}

/**
 * ボタン1つを LINE のアクションにする。LIFF のページ（回答フォーム・予約・予約履歴）は
 * そのアカウントの LIFF ID で URL を作る。LIFF ID が無いときは {{liff_id}} のまま
 * （画面は LIFF の無いアカウントでこの動きを選ばせない。保存の前にも carouselChoiceProblems で止める）。
 */
export function buildChoiceAction(a: Choice, postbackData: string, liffId: string | null): Record<string, string> {
  const label = a.label.trim()
  if (a.kind === 'action') return { type: 'postback', label, data: postbackData }
  if (a.kind === 'message') return { type: 'message', label, text: a.text.trim() }
  if (needsLiff(a.kind)) return { type: 'uri', label, uri: liffPageUrl(liffId || '{{liff_id}}', a.kind, a.formId) }
  return { type: 'uri', label, uri: a.uri.trim() }
}

/**
 * 保存の前に止める問題（文字のあるボタンだけ見る）。空なら保存してよい。
 * LINE に送ってから 400 で弾かれると、どのボタンが悪いのか分からないため。
 */
export function carouselChoiceProblems(panels: Panel[], liffId: string | null): string[] {
  const problems: string[] = []
  panels.forEach((p, ci) => {
    p.actions.forEach((a, ai) => {
      if (!a.label.trim()) return
      const where = `カード${ci + 1}のボタン${ai + 1}`
      if (a.kind === 'message') {
        if (!a.text.trim()) problems.push(`${where}の送る文を入力してください`)
        else if ([...a.text.trim()].length > MESSAGE_TEXT_MAX) problems.push(`${where}の送る文は${MESSAGE_TEXT_MAX}文字までです`)
      }
      if (a.kind === 'form' && !a.formId) problems.push(`${where}の回答フォームを選んでください`)
      if (needsLiff(a.kind) && !liffId) problems.push(`${where}：このアカウントに LIFF が登録されていないため、「${tapActionDef(a.kind)?.label}」は開けません`)
    })
  })
  return problems
}

/** 選択肢ごとのアクションは、パネル番号 → 選択肢番号 の入れ子で持つ。 */
export function buildCarouselActions(panels: Panel[]): Record<string, Record<string, unknown[]>> {
  const carouselActions: Record<string, Record<string, unknown[]>> = {}
  panels.forEach((p, ci) => {
    p.actions
      .filter((a) => a.label.trim())
      .forEach((a, ai) => {
        if (a.kind !== 'action' || a.actions.length === 0) return
        carouselActions[String(ci)] ??= {}
        carouselActions[String(ci)][String(ai)] = a.actions.map(toActionPayload)
      })
  })
  return carouselActions
}

/**
 * D009: 未保存の見分けに入れる中身。保存の口へ送る項目とそろえる。
 * `createdId` は人の入力ではないので入れない。
 */
export interface CarouselDirtyState {
  name: string
  panels: Panel[]
  folderId: string | null
  tapLimitMode: 'none' | 'once'
  tapLimitText: string
}

/**
 * D009: 保存ずみの正本と今の入力を同じ形の文字にする。1文字でも違えば
 * 「保存していない変更がある」とする。比べるのは値だけで、順番も含める
 * （パネルの並び替えも失われる作業のため）。
 */
export function carouselSnapshot(state: CarouselDirtyState): string {
  return JSON.stringify(state)
}

export interface CarouselSaveInput {
  expectedVersion?: number
  expectedDraftRevision?: number
  /**
   * 保存先のテンプレート id。URL の `?id=`、またはこの画面での保存が
   * 「作成」まで済んで「postback 埋め直し」で止まったときの作成済み id。
   * 後者を渡せば、再試行は新規作成ではなく更新になる（重複を作らない）。
   */
  templateId: string | null
  /** 新規作成のときだけ使う。 */
  selectedAccountId: string | null
  name: string
  panels: Panel[]
  folderId: string | null
  tapLimitMode: 'none' | 'once'
  tapLimitText: string
  /** 保存先アカウントの LIFF ID（回答フォーム・予約・予約履歴の URL に入れる）。無ければ null。 */
  liffId?: string | null
}

export type CarouselSaveResult =
  | {
      ok: true
      /** ★V8「保存して公開」が直後に公開口へ渡す保存先の id。 */
      id: string
      expectedVersion: number
      expectedDraftRevision: number
    }
  | {
      ok: false
      error: string
      /**
       * N-149: 作成だけ済んで後段が失敗したとき、その id を返す。
       * 画面はこれを覚えて、再試行を「作成し直し」ではなく「更新」にする。
       */
      createdId?: string
      expectedVersion?: number
      expectedDraftRevision?: number
      tapExtraError?: string
    }

export interface CarouselSaveOps {
  create: typeof api.templates.create
  update: typeof api.templates.update
}

/**
 * カルーセルを保存する。**失敗しても入力を捨てない、途中で止まっても
 * 同じ内容で再試行できる**ことが N-149 の要件。
 *
 * 新規は2段階。1段階目（作成）だけ済んで2段階目（postback の data に
 * id を埋めて保存し直し）が失敗したら、作成済みの id を `createdId` で
 * 返す。次の保存はそれを `templateId` へ入れて呼ばれるので、同じ
 * テンプレートへの更新としてやり直せ、二重に作られない。
 */
export async function saveCarousel(
  input: CarouselSaveInput,
  ops: CarouselSaveOps = { create: api.templates.create, update: api.templates.update },
): Promise<CarouselSaveResult> {
  // サーバー側でも同じ制限を見る。何枚目の何が問題かを返してくれる。
  const carouselActions = buildCarouselActions(input.panels)
  const carouselOptions = {
    carouselActions: Object.keys(carouselActions).length > 0 ? carouselActions : null,
    carouselTapLimitMode: input.tapLimitMode,
    carouselTapLimitText: input.tapLimitText.trim() || null,
  }

  /*
   * 作成が済んでからの失敗は、再試行を更新へ切り替えられるよう id を持ち
   * 回る。通信エラー（例外）でも同じ扱いにしないと、再試行で複製される。
   */
  let createdId: string | undefined
  let version = { expectedVersion: input.expectedVersion, expectedDraftRevision: input.expectedDraftRevision }
  const fail = (error: string): CarouselSaveResult =>
    createdId ? { ok: false, error, createdId, ...version } : { ok: false, error }

  try {
    if (input.templateId) {
      // 更新、または「作成済みへのやり直し」。id が決まっているので
      // postback の data も最初から正しく入る。
      const res = await ops.update(input.templateId, {
        ...version,
        name: input.name.trim(),
        messageType: 'carousel',
        messageContent: buildCarouselContent(input.panels, input.templateId, input.liffId ?? null),
        folderId: input.folderId,
        ...carouselOptions,
      })
      if (!res?.success) return fail(res?.error || '保存できませんでした')
      if (!res.data) return fail('保存結果を確認できませんでした')
      return { ok: true, id: input.templateId, expectedVersion: res.data.publishedVersion, expectedDraftRevision: res.data.draftRevision }
    }

    if (!input.selectedAccountId) return fail('LINE公式アカウントを選んでください')
    const created = await ops.create({
      accountId: input.selectedAccountId,
      name: input.name.trim(),
      category: 'カルーセル',
      messageType: 'carousel',
      messageContent: buildCarouselContent(input.panels, '', input.liffId ?? null),
      folderId: input.folderId,
      ...carouselOptions,
    })
    if (!created?.success) return fail(created?.error || '保存できませんでした')
    if (!created.data?.id) return fail('保存結果を確認できませんでした')
    createdId = created.data.id
    version = { expectedVersion: created.data.publishedVersion, expectedDraftRevision: created.data.draftRevision }

    // id が決まったので、postback の data を埋め直す。
    // 「押されたときに何かする」選択肢が1つも無ければ、埋め直す必要はない。
    const hasPostback = input.panels.some((p) => p.actions.some((a) => a.kind === 'action'))
    if (hasPostback) {
      const fixed = await ops.update(createdId, {
        ...version,
        messageContent: buildCarouselContent(input.panels, createdId, input.liffId ?? null),
      })
      if (!fixed?.success) return fail(fixed?.error || '保存できませんでした')
      if (!fixed.data) return fail('保存結果を確認できませんでした')
      version = { expectedVersion: fixed.data.publishedVersion, expectedDraftRevision: fixed.data.draftRevision }
    }
    return { ok: true, id: createdId, expectedVersion: version.expectedVersion!, expectedDraftRevision: version.expectedDraftRevision! }
  } catch (e) {
    return { ...fail(describeApiFailure(e, '保存')), ...(tapExtraSaveError(e) ? { tapExtraError: tapExtraSaveError(e)! } : {}) }
  }
}
