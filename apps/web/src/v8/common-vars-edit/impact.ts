import { knownValue } from '@/lib/known-value'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
/*
 * 共通情報の編集で使う「変える前に影響を見る」の言葉と判定。
 * `app/contents/vars/change-impact.ts`・`delete-impact.ts`・`impact-review.tsx` から写した
 * （src/v8 から @/app は読まない決まり）。直すときは元と同じ判断を入れる。
 */
import type { CommonVarChangeImpact, CommonVarDeleteImpact } from '@line-crm/shared'
import { ApiError } from '@/lib/api'
import { STATE_TEXT, notConnectedText } from '@/components/shared/not-connected'
import { csvCell } from '@/lib/presentation'
import { formatDateTime, formatNumber } from '@/lib/format'

/**
 * 共通情報を**変える前**の影響確認（設計 `uNBlA` 14-1-B）。
 *
 * この画面は「値を直して保存する」だけの形になっていた。差し込み先が
 * 何十か所あっても、押した瞬間に全部が変わる。**変える前に、どこが
 * 変わるのかを見せる**のが設計の骨である。
 *
 * いま読める口は使用先台帳（`GET /api/common-vars/:id/delete-impact`）
 * だけである。ここからは「どこで使われているか」「いまどう出ているか」
 * 「送信済みで変わらないもの」が読める。
 *
 * **2026-09-04：変更後の文と文字数の検査もつながった。**
 * `POST /api/common-vars/:id/impact-preview`（PR #773）から、保存後の文・
 * 文字数・上限超えが返る。値を変えていないあいだは使用先台帳だけを読み、
 * 変えた時点で変更前確認へ切り替える。
 *
 * **口が答えられないところは、いまも `—` と理由を出す。** 差し込みの
 * 目印を本文から読み取れない使用先（`previewAvailable: false`）は変更後の
 * 文を作れない。そこを空文字で埋めると「変更後は空になる」と読める。
 */

/** 影響確認の読み込み状態。**実値0と、読めなかったを混ぜない。** */
export type ChangeImpactState = 'loading' | 'ready' | 'error' | 'forbidden'

/** 口がまだ無い節の呼び名。未接続の理由文をここから作る。 */
export const CHANGE_PREVIEW_SOURCE = '変更後の文と文字数の検査'

/** 「変更後の文」の節に出す理由。 */
export function changePreviewNotConnected(): string {
  return notConnectedText(CHANGE_PREVIEW_SOURCE)
}

/** 読み込みに失敗したときの状態。403は「見る権限がありません」と分ける。 */
export function impactStateFromError(err: unknown): ChangeImpactState {
  return err instanceof ApiError && err.status === 403 ? 'forbidden' : 'error'
}

/**
 * 予約の登録が落ちた理由を、運用者の言葉にする。
 *
 * `saveErrorText` と同じ考え方。本文をそのまま出してよいのは400だけ。
 * 500の `Internal server error` は出さず、予約用の定型文に写す。
 */
export function scheduleErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 400 && japaneseDetailOf(err)) return japaneseDetailOf(err)
  if (err instanceof ApiError && err.status === 403) {
    return `${STATE_TEXT.forbiddenAct}。更新予約を作れるのは管理者だけです。`
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'この共通情報は見つかりませんでした。一覧から開き直してください。'
  }
  return '予約を登録できませんでした。時間をおいて、もう一度お試しください。'
    + '続く場合は管理者へ連絡してください。'
}

/** 数が出ないときに、その理由を運用者の言葉で言う。 */
export function impactStateText(state: ChangeImpactState): string | null {
  if (state === 'loading') return STATE_TEXT.loading
  if (state === 'error') return STATE_TEXT.error
  if (state === 'forbidden') return STATE_TEXT.forbiddenView
  return null
}

/**
 * 保存すると何か所が変わるか。
 *
 * `total` には送信済みの記録も入っている。**送信済みは変わらない。**
 * まとめて「15か所が変わります」と言うと、もう送った分まで書き換わると
 * 読めてしまう。分けて数える。
 */
export function changeCounts(impact: CommonVarDeleteImpact | CommonVarChangeImpact): {
  immediate: number
  historical: number
  hidden: number
} {
  return {
    immediate: impact.blockingTotal,
    historical: impact.historicalTotal,
    hidden: impact.unscopedFormTotal,
  }
}

/**
 * 節の見出し文。
 *
 * **0か所は0か所と言う。** 差し込まれていない共通情報なら、保存しても
 * どこも変わらない。それが分かれば運用者はそのまま保存できる。
 */
export function changeSummaryText(impact: CommonVarDeleteImpact | CommonVarChangeImpact): string {
  const { immediate } = changeCounts(impact)
  if (immediate === 0) {
    return `${placeholderText(impact.variable.varKey)} はどこにも差し込まれていません。`
      + '保存しても、いま変わる場所はありません。'
  }
  return `保存すると、${placeholderText(impact.variable.varKey)} を差し込んでいる `
    + `${formatNumber(immediate)}か所がすぐ変わります。`
}

/** 送信済みの分。**「変わりません」を書かないと、遡って直ると誤解される。** */
export function historicalText(impact: CommonVarDeleteImpact | CommonVarChangeImpact): string | null {
  const { historical } = changeCounts(impact)
  if (historical === 0) return null
  return `送信済みの${formatNumber(historical)}か所は変わりません。`
    + 'すでに届いた文は書き換わりません。'
}

/** 名前を出せない使用先。**件数は隠さない。** */
export function hiddenText(impact: CommonVarDeleteImpact | CommonVarChangeImpact): string | null {
  if (impact.unavailableReferences.length === 0) return null
  return impact.unavailableReferences
    .map((ref) => `${ref.kindLabel}${formatNumber(ref.count)} 件（${ref.reason}）`)
    .join('／')
}

/** すぐ変わる使用先だけを、表に出す順で返す。送信済みは混ぜない。 */
export function immediateItems(impact: CommonVarDeleteImpact | CommonVarChangeImpact) {
  return impact.items.filter((item) => item.blocksDeletion)
}

/*
 * IDEA-14: 保存する**前**に、変わる範囲を「編集中・公開中・予約中」で分けて
 * 見せる。種類（テンプレート・配信…）だけでは、同じ配信でも書いている
 * 途中か・予約済みかで直し方が違うため、状態ごとに数える。
 *
 * 呼び名は口（commonVarUsageStatus）が返すものをそのまま使い、表の
 * 状態欄と同じ語彙で並べる。口が知らない呼び名をこちらで作らない。
 */
const REFLECTION_STATUS_ORDER = [
  '下書き', '公開中', '配信予約中', '配信中', '使われています', '停止中',
] as const

/** 「変わる場所」の状態別の内訳。変わるものが無ければ出さない。 */
export function reflectionScopeText(
  impact: CommonVarDeleteImpact | CommonVarChangeImpact,
): string | null {
  const counts = new Map<string, number>()
  for (const item of immediateItems(impact)) {
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const known = REFLECTION_STATUS_ORDER.filter((label) => counts.has(label))
  const unknown = [...counts.keys()].filter(
    (label) => !(REFLECTION_STATUS_ORDER as readonly string[]).includes(label),
  )
  return `内訳: ${[...known, ...unknown]
    .map((label) => `${label}${formatNumber(counts.get(label)!)} 件`)
    .join('・')}`
}

/**
 * いつから新しい値になるか、そして何が変わらないか。
 *
 * 処理の実態（common-var-snapshot.ts・applyDueCommonVarSchedules）と
 * そろえる。
 * - 下書き・公開中・配信予約中のものは、送る・実行するときに値を読む。
 *   次に動くときから新しい値が入る。
 * - 送信を始めた配信は、開始時点の値の写しを持つので、あとから値を
 *   直してもその配信は変わらない。
 * - 送信済みの文も、そのときの値のまま変わらない。
 */
export function reflectionTimingText(
  impact: CommonVarDeleteImpact | CommonVarChangeImpact,
): string | null {
  const { immediate, historical } = changeCounts(impact)
  const fixed = impact.sendingFixedTotal
  if (immediate === 0 && historical === 0 && fixed === 0) return null
  const parts: string[] = []
  if (immediate > 0) {
    parts.push('変わる場所は、次に送る・実行されるときから新しい値が入ります。')
    const hasScheduled = immediateItems(impact).some(
      (item) => item.status === '配信予約中',
    )
    if (hasScheduled) {
      parts.push('配信予約中のものは、送信を始めるときの新しい値で送られます。')
    }
  }
  const unchanged: string[] = []
  if (fixed > 0) {
    unchanged.push(`送信を始めた配信${formatNumber(fixed)}か所`)
  }
  if (historical > 0) {
    unchanged.push(`送信済み${formatNumber(historical)}か所`)
  }
  if (unchanged.length > 0) {
    parts.push(`${unchanged.join('と')}は、そのときの値のまま変わりません。`)
  }
  return parts.join('')
}

/**
 * 保存が落ちた理由を、運用者の言葉にする。
 *
 * `fetchApi` は2xx以外を投げるので、`if (!res.success)` の枝には
 * 届かない。**そのまま catch で「保存に失敗しました」だけ出すと、
 * 権限が無いのか、対象が消えたのか、サーバーが落ちたのかが分からず、
 * 運用者は同じ操作を繰り返すしかなくなる。**
 *
 * 本文をそのまま出してよいのは400だけ（`BODY_MESSAGE_STATUSES`）。
 * それ以外は `API error: 500` のような内部文が入るので、status から
 * こちらで言葉を決める。
 */
export function saveErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return '保存できませんでした。通信が切れている可能性があります。'
      + '接続を確かめて、もう一度お試しください。'
  }
  if (err.status === 400 && japaneseDetailOf(err)) return japaneseDetailOf(err)
  switch (err.status) {
    case 400:
      return '入力の内容が受け付けられませんでした。名前と値を確かめてください。'
    case 401:
      return 'ログインの状態が切れています。ログインし直してから、もう一度お試しください。'
    case 403:
      return `${STATE_TEXT.forbiddenAct}。共通情報を保存できるのは管理者だけです。`
    case 404:
      return 'この共通情報は見つかりませんでした。'
        + 'ほかの人が削除したか、選んでいるLINEアカウントが違います。一覧から開き直してください。'
    case 409:
      /*
       * 編集画面は409を受けても入力欄を消さない（IDEA-14）。いま保存
       * されている版だけを取り直し、打ち込んだ内容はそのまま残る。
       * 「読み込んでから」と言うと入力が消えると読めるので、残ることと
       * 上書きになることを書く。
       */
      if (err.code === 'impact_usage_changed') {
        return '影響を確認したあとに使用先が変わりました。'
          + '確認を読み直したので、内容を確かめてからもう一度保存してください。'
      }
      return 'ほかの人が先に保存しました。入力した内容は残っています。'
        + 'もう一度保存すると、その内容で上書きします。'
    case 422:
      return '差し込み名は後から変えられません。名前と値だけを直してください。'
    case 428:
      return '保存の前に影響の確認が必要です。確認を読み直したので、もう一度保存してください。'
    case 429:
      return '短い時間に操作が集中しました。少し待ってから、もう一度お試しください。'
    default:
      return err.status >= 500
        ? 'サーバー側で保存できませんでした。時間をおいて、もう一度お試しください。'
          + '続く場合は管理者へ連絡してください。'
        : '保存できませんでした。もう一度お試しください。'
  }
}


/*
  ここから下は、変更後の文が読めるようになってから足したもの。
  上の関数は `CommonVarDeleteImpact` を受けるので、`CommonVarChangeImpact`
  もそのまま渡せる（項目が増えただけで、形は同じ）。
*/

/**
 * 保存を止めるかどうか。
 *
 * **止める理由が1つでもあれば保存させない。** 5,000文字を超える文を
 * 保存すると、その通は送信のときに落ちる。**落ちるのは保存の何日も
 * あとで、原因がこの操作だと結びつかない。**
 */
export function blockingErrors(impact: CommonVarChangeImpact): string[] {
  const seen = new Set<string>()
  for (const item of impact.items) for (const message of item.errors) seen.add(message)
  return [...seen]
}

/** 保存はできるが、目で確かめてほしいこと。 */
export function reviewWarnings(impact: CommonVarChangeImpact): string[] {
  const seen = new Set<string>()
  for (const item of impact.items) for (const message of item.warnings) seen.add(message)
  return [...seen]
}

/**
 * 1件ぶんの文字数の言い方。
 *
 * **上限が無い使用先で「/ 5,000」と書かない。** 上限があるのは LINE の
 * 本文になるものだけで、それ以外に上限を書くと、無い決まりを作ってしまう。
 */
export function characterCountText(item: CommonVarChangeImpact['items'][number]): string {
  if (item.nextCharacterCount === null) return '—'
  const next = formatNumber(item.nextCharacterCount)
  if (item.characterLimit === null) return `${next}文字`
  return `${next} / ${formatNumber(item.characterLimit)}文字`
}

/**
 * この1件が変更前確認のものか。
 *
 * `in` だけだと型が絞れず、`nextPreview` を読むところで落ちる。
 * 見分けを1か所に置いて、画面側は使うだけにする。
 */
export function isChangeItem(
  item: CommonVarDeleteImpact['items'][number] | CommonVarChangeImpact['items'][number],
): item is CommonVarChangeImpact['items'][number] {
  return 'changesOnSave' in item
}


/** 取得元が無い値。実値の0とは別。 */
export const NOT_AVAILABLE_TEXT = '—（未取得）'

/** 差し込みキーの見せ方（本文で置き換わる `{{var.key}}` の形）。 */
export function placeholderText(varKey: string): string {
  return `{{var.${varKey}}}`
}

/** 確かめた時刻。 */
export function checkedAtText(checkedAt: string): string {
  const date = new Date(checkedAt)
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE_TEXT
  return formatDateTime(date)
}

/** 影響の一覧を CSV にする（変わる行だけ）。 */
export function impactCsv(impact: CommonVarChangeImpact): string {
  return [
    ['どこ', '種類', 'いまの文', '変わったあとの文', '状態'],
    ...impact.items.filter((item) => item.changesOnSave).map((item) => [
      item.name,
      item.kindLabel,
      item.currentPreview,
      item.nextPreview ?? '未取得',
      item.status,
    ]),
  ].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

const KIND_LABELS: Record<string, string> = {
  template: 'テンプレート',
  broadcast: '一斉配信',
  scenario: 'シナリオ配信',
  reminder: 'リマインダ',
  auto_reply: '自動応答',
  form: '回答フォーム',
  automation: 'オートメーション',
  friend_add: '友だち追加時の配信',
  common_action: '共通アクション',
}

export function impactBreakdown(impact: CommonVarChangeImpact): string {
  const values = Object.entries(impact.byKind)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${knownValue(KIND_LABELS, kind, kind)}${formatNumber(count)}`)
  return values.length > 0 ? values.join('・') : '種類別の内訳はありません'
}

export function urgentImpactCount(impact: CommonVarChangeImpact): number | null {
  const connected = impact as CommonVarChangeImpact & {
    scheduledUsageCount?: number
    publishedUsageCount?: number
  }
  if (typeof connected.scheduledUsageCount === 'number' && typeof connected.publishedUsageCount === 'number') {
    return connected.scheduledUsageCount + connected.publishedUsageCount
  }
  const items = impact.items.filter((item) => item.changesOnSave)
  if (items.some((item) => item.status === '使われています')) return null
  // 状態の語彙は口（commonVarUsageStatus）とそろえる。口が返さない呼び名は使わない。
  return items.filter((item) => /配信予約中|配信中/.test(item.status)).length
}

export function overLimitCount(impact: CommonVarChangeImpact): number {
  return impact.items.filter((item) => item.exceedsCharacterLimit).length
}
