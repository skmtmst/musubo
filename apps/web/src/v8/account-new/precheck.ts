/* ===== ①事前確認（LINE新規追加_v07.pen・2026-10-18承認／p6zMkA）の小さな計算 =====
 *
 * もとは logic.ts にあった。行数の関所（apps/web/scripts/v8-guard/code-size.mjs・
 * 1ファイル400行）を越えたので切り出した。中身・判定は変えていない。
 * 読む側の import を変えないよう、logic.ts からそのまま出し直している。
 *
 * ①は質問を1つずつ出す。新料金の事前確認で友だち人数を尋ねるため、
 * 旧Q3の50万人確認はこのウィザードでは尋ねない。
 */

export type PrecheckKey = 'q1' | 'q2' | 'q4' | 'q5'
export type PrecheckYesNo = 'yes' | 'no'
export type PrecheckUse = 'both' | 'switch' | 'try'
export interface PrecheckAnswers {
  q1?: PrecheckYesNo; q2?: PrecheckYesNo; q4?: PrecheckYesNo; q5?: PrecheckUse
}
/** ①で今出している面。全部答え終わると 'done'（チェック結果・①-7）。 */
export type PrecheckAt = PrecheckKey | 'done'

export const PRECHECK_ORDER: readonly PrecheckKey[] = ['q1', 'q2', 'q4', 'q5']

export const PRECHECK_TITLES: Record<PrecheckKey, string> = {
  q1: 'Q1. LINE公式アカウントはありますか？',
  q2: 'Q2. いまの友だちを引き継ぎますか？',
  q4: 'Q3. ほかのLINE配信ツールを使っていますか？',
  q5: 'Q4. そのツールを、これからどうしますか？',
}
export const PRECHECK_HELPS: Record<PrecheckKey, string> = {
  q1: 'お店用のLINE公式アカウントのことです。ふだんの個人のLINEとは別のものです。',
  q2: 'いまのLINE公式アカウントの友だちを、musuboで続けて使うかどうかです。',
  q4: 'LINE公式アカウントにつないで、メッセージの配信や自動応答を行うツールのことです。',
  q5: 'あてはまるものを1つ選んでください。',
}
export interface PrecheckChoice { value: string; title: string; note?: string }
export const PRECHECK_CHOICES: Record<PrecheckKey, readonly PrecheckChoice[]> = {
  q1: [{ value: 'yes', title: 'はい、あります' }, { value: 'no', title: 'いいえ、まだありません' }],
  q2: [{ value: 'yes', title: 'はい、引き継ぎます' }, { value: 'no', title: 'いいえ、引き継ぎません' }],
  q4: [{ value: 'yes', title: '使っています' }, { value: 'no', title: '使っていません' }],
  q5: [
    { value: 'both', title: 'ほかのツールと併用する', note: 'musuboとほかのツールを、しばらく両方使います。' },
    { value: 'switch', title: 'musuboに乗り換える', note: 'ほかのツールをやめて、musuboだけにします。' },
    { value: 'try', title: 'まずは試してみる', note: '本格的に使う前に、musuboの画面や機能を確かめます。' },
  ],
}

export const PRECHECK_SUMMARY_LABELS: Record<PrecheckKey, string> = {
  q1: 'Q1. LINE公式アカウント', q2: 'Q2. 友だちの引き継ぎ',
  q4: 'Q3. ほかの配信ツール', q5: 'Q4. これからの使い方',
}
const PRECHECK_SUMMARY_VALUES: Record<PrecheckKey, Record<string, string>> = {
  q1: { yes: 'あります', no: 'ありません' },
  q2: { yes: 'はい、引き継ぎます', no: 'いいえ、引き継ぎません' },
  q4: { yes: '使っています', no: '使っていません' },
  q5: { both: 'ほかのツールと併用する', switch: 'musuboに乗り換える', try: 'まずは試してみる' },
}

/** ①の札。「質問 1」〜「質問 4」と「チェック完了」。②③の `stepLabel` は①では空を返す。 */
export function precheckStateLabel(at: PrecheckAt): string {
  return at === 'done' ? 'チェック完了' : `質問 ${PRECHECK_ORDER.indexOf(at) + 1}`
}

/** 最後のツールの使い方は、ほかのツールを使う場合だけ尋ねる。 */
export function precheckAsked(key: PrecheckKey, answers: PrecheckAnswers): boolean {
  if (key === 'q5') return answers.q4 === 'yes'
  return true
}

/**
 * 次に出す面。未回答のときと、行き止まり（Q1=いいえ）では null を返す。
 * null のあいだは「次へ」を押せない＝②へ進めない。
 */
export function precheckNext(at: PrecheckAt, answers: PrecheckAnswers): PrecheckAt | null {
  if (at === 'done') return null
  if (answers[at] === undefined) return null
  if (at === 'q1' && answers.q1 === 'no') return null
  const rest = PRECHECK_ORDER.slice(PRECHECK_ORDER.indexOf(at) + 1).filter((key) => precheckAsked(key, answers))
  return rest[0] ?? 'done'
}

/** ひとつ前に尋ねた質問。①の先頭にいるときは null（＝①より前には戻らない）。 */
export function precheckBack(at: PrecheckAt, answers: PrecheckAnswers): PrecheckAt | null {
  const asked = PRECHECK_ORDER.filter((key) => precheckAsked(key, answers))
  if (at === 'done') return asked[asked.length - 1] ?? null
  const index = asked.indexOf(at)
  return index > 0 ? asked[index - 1] : null
}

/**
 * 答えた質問を「Qn. ラベル　→　答え」で並べる（絵 mDP83・y36RB・plqG6 など）。
 * 今いる質問も、すでに答えてあれば並べる（v07 ①-9 は Q2 の面で Q1・Q2 の2行）。
 */
export interface PrecheckSummaryRow { key: PrecheckKey; label: string; value: string }
export function precheckSummary(at: PrecheckAt, answers: PrecheckAnswers): PrecheckSummaryRow[] {
  const stopAt = at === 'done' ? PRECHECK_ORDER.length : PRECHECK_ORDER.indexOf(at) + 1
  const rows: PrecheckSummaryRow[] = []
  for (let i = 0; i < stopAt; i += 1) {
    const key = PRECHECK_ORDER[i]
    const answer = answers[key]
    if (!answer || !precheckAsked(key, answers)) continue
    rows.push({ key, label: PRECHECK_SUMMARY_LABELS[key], value: PRECHECK_SUMMARY_VALUES[key][answer] ?? '' })
  }
  return rows
}

/** ①-7「あなたの接続前チェック結果」の4項目（絵 tLhTV〜IvIdn の固定文）。 */
export interface PrecheckResultItem { title: string; body: string }
export const PRECHECK_RESULT: readonly PrecheckResultItem[] = [
  { title: '用意するもの', body: 'Messaging API と LINEログインのチャネルID・チャネルシークレット（計4つ）と、Messaging API チャネルが属するプロバイダーID。プロバイダーIDは LINE Developers の「プロバイダー設定」にあるコピーアイコンから取得できます。' },
  { title: '接続後に変わること', body: 'メッセージをmusuboで受け取ります。LINE公式アカウントの「チャット」は、そのまま使えます。二重に返信しないよう、LINE Official Account Managerの「あいさつメッセージ」「応答メッセージ」はオフにしてください。' },
  { title: '作り直すもの', body: 'あいさつメッセージとリッチメニューは引き継げません。musuboで作り直してから切り替えます。' },
  { title: 'かかる時間', body: '入力から接続の確認まで、およそ10〜15分です。' },
]

/** ①-9 の確かめる印。これにチェックが付くまで Q2=はい からは先へ進めない。 */
export const PRECHECK_VERIFIED_ACK = 'precheckVerifiedAccount'

/**
 * 答えに応じて質問の下に出す案内（①-1／①-2／①-9／①-4〜6）。
 * `link.href` に `external` が無いものは管理画面の中の画面。
 */
export interface PrecheckNote {
  tone: 'info' | 'warn'
  /** 見出し。①-1 だけは見出しを持たない。 */
  title: string
  body: string
  link?: { label: string; href: string; note: string; external?: boolean }
  ack?: { key: string; label: string }
}
export function precheckNote(at: PrecheckAt, answers: PrecheckAnswers): PrecheckNote | null {
  if (at === 'q1' && answers.q1 === 'no') {
    return {
      tone: 'info', title: '',
      body: 'musuboはLINE公式アカウントとつないで使います。先に無料のLINE公式アカウントを作ってください。',
      link: { label: 'LINE公式アカウントを作る', href: 'https://manager.line.biz/', note: '作ったら、この画面に戻って続きを進められます。', external: true },
    }
  }
  if (at === 'q2' && answers.q2 === 'yes') {
    return {
      tone: 'warn', title: '友だちを引き継ぐには、認証済みアカウントが必要です',
      body: '認証済みアカウントでない場合、いまの友だちの一括取り込みができません。引き継ぐ場合は、先にLINEヤフーの認証済みアカウントの申請を済ませてください。',
      link: { label: '認証済みアカウントの説明を見る', href: 'https://www.lycbiz.com/jp/service/line-official-account/account-type/', note: 'LINEヤフー for Businessの説明ページが開きます。', external: true },
      ack: { key: PRECHECK_VERIFIED_ACK, label: '認証済みアカウントであることを確認した' },
    }
  }
  if (at === 'q5' && answers.q5 === 'both') {
    return {
      tone: 'warn', title: '自動の受け取りが使えるのは1つのツールだけです',
      body: 'メッセージの自動受け取り（Webhook）は、同時に1つのツールでしか使えません。接続のとき、musuboで使う設定をご案内します。',
    }
  }
  if (at === 'q5' && answers.q5 === 'switch') {
    return {
      tone: 'info', title: '二重に届かない切り替え方をご案内します',
      body: 'あいさつメッセージやリッチメニューは引き継げないため、musuboで作り直してから切り替えます。お客さまに同じ連絡が二重に届かない手順でご案内します。',
    }
  }
  if (at === 'q5' && answers.q5 === 'try') {
    return {
      tone: 'info', title: 'テスト用のアカウントでも試せます',
      body: '本番のアカウントには影響しません。配信を始める前なら、いつでも接続をやり直せます。',
    }
  }
  return null
}

/** ①を抜けられるか。行き止まり・未回答・①-9の印の未チェックで止める。 */
export function precheckBlocked(at: PrecheckAt, answers: PrecheckAnswers, acks: Record<string, boolean>): boolean {
  if (at === 'done') return false
  if (precheckNext(at, answers) === null) return true
  const note = precheckNote(at, answers)
  return note?.ack ? !acks[note.ack.key] : false
}

/** 下書きから戻した①の答え。知らない値は捨てる。 */
export function readPrecheckAnswers(value: unknown): PrecheckAnswers {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const yesNo = (key: PrecheckKey): PrecheckYesNo | undefined =>
    raw[key] === 'yes' || raw[key] === 'no' ? raw[key] as PrecheckYesNo : undefined
  const use = raw.q5 === 'both' || raw.q5 === 'switch' || raw.q5 === 'try' ? raw.q5 as PrecheckUse : undefined
  const answers: PrecheckAnswers = {}
  for (const key of ['q1', 'q2', 'q4'] as const) {
    const answer = yesNo(key)
    if (answer) answers[key] = answer
  }
  if (use) answers.q5 = use
  return answers
}

/** 下書きから戻した①の面。尋ねない質問を指していたら先頭へ戻す。 */
export function readPrecheckAt(value: unknown, answers: PrecheckAnswers): PrecheckAt {
  if (value === 'done') return 'done'
  const key = PRECHECK_ORDER.find((candidate) => candidate === value)
  return key && precheckAsked(key, answers) ? key : 'q1'
}
