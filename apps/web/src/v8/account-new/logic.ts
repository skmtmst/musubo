
import { jstDateOffset } from '@/lib/jst-datetime'
import { ApiError } from '@/lib/api/transport/errors'
/*
 * ★V8 LINEアカウントを登録の、画面に依らない小さな計算。
 * src/v8 からは @/app を読めないので、今の登録（app/accounts/connection-check-view.ts・
 * app/accounts/new/account-recovery.ts・app/accounts/new/register-v8.tsx）から写した。
 * 中身・判定は同じ。片方を直したらもう片方も同じに直す。
 */
// 下の readDraft で使う。下の `export * from './precheck'` は出し直しだけで、ここでは使えない。
import { PRECHECK_VERIFIED_ACK, readPrecheckAnswers, readPrecheckAt, type PrecheckAnswers, type PrecheckAt } from './precheck'

/** R523: 同じチャネルIDで作られた行が1件だけなら、その ID。 */
export function matchRegisteredAccountId(accounts: Array<{ id: string; channelId: string }>, channelId: string): string | null {
  const want = channelId.trim()
  if (!want) return null
  const found = accounts.filter((account) => account.channelId === want)
  return found.length === 1 ? found[0].id : null
}

/** サーバの重複エラーの目印（英語のまま返ることがある）。 */
export function isDuplicateChannelError(message: string): boolean {
  return /already registered|UNIQUE constraint|このLINEチャネルは登録済みです/i.test(message)
}

export function isDuplicateChannelResponse(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false
  const { message } = error
  return isDuplicateChannelError(message)
}

/** 友だち数の統計は前日分。日本時間の昨日を yyyyMMdd で返す。 */
export function insightDateJst(now: Date = new Date()): string {
  return jstDateOffset(-1, now).replaceAll('-', '')
}


export const DRAFT_KEY = 'musubo-register-draft-v8'
export type StepNumber = 1 | 2 | 3 | 4 | 5
export interface DraftState {
  step: StepNumber
  /** ②③の中の小さな段（1始まり）。段の無い画面では1。 */
  sub: number
  /** 以前の3段の下書きを4段へ読み替えるための版。 */
  connectionStepsVersion?: 4
  accountMethod: 'existing' | 'new'
  /** ①事前確認の答えと、今出している面。古い下書きには無いので既定へ寄せる。 */
  precheck: PrecheckAnswers
  precheckAt: PrecheckAt
  acks?: Record<string, boolean>
  name: string; channelId: string; providerId: string; loginChannelId: string; lineId: string
  tagIds: string[]; parentId: string; staffIds: string[]; liffId: string; importFriends: boolean
  importFriendsExplicit?: boolean
}

/** 指定した保存キーの下書きを読む。秘密値は復元しない。 */
export function readDraft(storage: Pick<Storage, 'getItem'>, key = DRAFT_KEY): DraftState | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DraftState>
    if (parsed.step !== 1 && parsed.step !== 2 && parsed.step !== 3 && parsed.step !== 4) return null
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    const total = subTotal(parsed.step)
    const savedSub = typeof parsed.sub === 'number' && Number.isInteger(parsed.sub) && parsed.sub >= 1 && parsed.sub <= Math.max(1, total) ? parsed.sub : 1
    const sub = parsed.step === 2 && parsed.connectionStepsVersion !== 4 && (savedSub === 2 || savedSub === 3) ? savedSub + 1 : savedSub
    const precheck = readPrecheckAnswers(parsed.precheck)
    const draft: DraftState = {
      step: parsed.step, sub, connectionStepsVersion: 4, accountMethod: parsed.accountMethod === 'new' ? 'new' : 'existing',
      precheck, precheckAt: readPrecheckAt(parsed.precheckAt, precheck),
      acks: Object.fromEntries(
        [...WEBHOOK_ACKS.map(item => item.key), ...LOGIN_ACKS.map(item => item.key), PRECHECK_VERIFIED_ACK].flatMap(key => parsed.acks?.[key] === true ? [[key, true]] : []),
      ),
      name: text(parsed.name), channelId: text(parsed.channelId), providerId: text(parsed.providerId), loginChannelId: text(parsed.loginChannelId), lineId: text(parsed.lineId),
      tagIds: ids(parsed.tagIds), parentId: text(parsed.parentId), staffIds: ids(parsed.staffIds), liffId: text(parsed.liffId),
      importFriends: parsed.importFriends !== false,
      importFriendsExplicit: parsed.importFriendsExplicit === true
        || (parsed.importFriendsExplicit === undefined && parsed.step >= 3 && typeof parsed.importFriends === 'boolean'),
    }
    // 手順1のまま何も入れていない下書きは戻さない（画面を開き直しただけで「下書きから続けます」を出さない）。
    const empty = draft.step === 1 && draft.precheckAt === 'q1' && Object.keys(draft.precheck).length === 0
      && !draft.name && !draft.channelId && !draft.providerId && !draft.loginChannelId
      && !draft.lineId && draft.tagIds.length === 0 && !draft.parentId && draft.staffIds.length === 0 && !draft.liffId
    return empty ? null : draft
  } catch {
    return null
  }
}

export interface ChannelFields { channelId: string; channelSecret: string; providerId: string; loginChannelId: string; loginChannelSecret: string }
export type ChannelField = keyof ChannelFields
export function channelErrors(form: ChannelFields): Record<string, string> {
  return { ...messagingApiErrors(form), ...providerIdErrors(form), ...loginChannelErrors(form) }
}

/* ===== ここから v07（LINE新規追加_v07.pen・2026-10-18承認）の小さな計算 ===== */

/** ②の Step1 で入れる Messaging API の2項目を調べる。 */
export function messagingApiErrors(form: Pick<ChannelFields, 'channelId' | 'channelSecret'>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.channelId.trim()) errors.channelId = 'チャネルIDを入力してください。'
  else if (!/^\d+$/.test(form.channelId)) errors.channelId = 'チャネルIDは余分な空白を除き、半角数字で入力してください。'
  if (!form.channelSecret) errors.channelSecret = 'チャネルシークレットを入力してください。'
  else if (/\s/.test(form.channelSecret)) errors.channelSecret = 'チャネルシークレットに空白や改行があります。LINEのコピーから貼り直してください。'
  return errors
}

/** ②の Step2 で入れるプロバイダーIDを調べる。 */
export function providerIdErrors(form: Pick<ChannelFields, 'providerId'>): Record<string, string> {
  if (!form.providerId.trim()) return { providerId: 'プロバイダーIDを入力してください。' }
  if (!/^\d+$/.test(form.providerId)) return { providerId: 'プロバイダーIDは余分な空白を除き、半角数字で入力してください。' }
  return {}
}

/** ②の Step4 で入れる LINEログインの2項目だけを調べる。 */
export function loginChannelErrors(form: Pick<ChannelFields, 'loginChannelId' | 'loginChannelSecret'> & Partial<Pick<ChannelFields, 'channelId'>>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.loginChannelId.trim()) errors.loginChannelId = 'LoginチャネルIDを入力してください。'
  else if (!/^\d+$/.test(form.loginChannelId)) errors.loginChannelId = 'LoginチャネルIDは余分な空白を除き、半角数字で入力してください。'
  else if (form.channelId && form.loginChannelId === form.channelId) errors.loginChannelId = 'Messaging APIと同じIDです。LINEログインチャネルのIDをコピーしてください。'
  if (!form.loginChannelSecret) errors.loginChannelSecret = 'Loginチャネルシークレットを入力してください。'
  else if (/\s/.test(form.loginChannelSecret)) errors.loginChannelSecret = 'Loginチャネルシークレットに空白や改行があります。LINEのコピーから貼り直してください。'
  return errors
}

/** LINEの仕様に固定桁数は置かず、明らかな桁違いだけ確認を促す。正しい値なら先へ進める。 */
export function channelLengthWarning(field: ChannelField, value: string): string | null {
  if (!value) return null
  const isSecret = field === 'channelSecret' || field === 'loginChannelSecret'
  if (isSecret ? value.length >= 24 && value.length <= 64 : value.length >= 8 && value.length <= 16) return null
  const source = field === 'channelId' || field === 'channelSecret' ? '公式アカウントマネージャー'
    : 'LINE Developers'
  return `桁数が通常と異なる可能性があります（現在${value.length}${isSecret ? '文字' : '桁'}）。${source}のコピー元を確認してください。正しければ「次のステップへ」をもう一度押して進めます。`
}

/** ②は4つ、③は2つの小さな段に分かれる。ほかの画面に小さな段は無い。 */
export function subTotal(stage: StepNumber): number {
  return stage === 2 ? 4 : stage === 3 ? 2 : 0
}

/** 小さな段の見出しの字。「Step 2 / 4」。状態の札ではない。段の無い画面では空。 */
export function stepLabel(stage: StepNumber, sub: number): string {
  const total = subTotal(stage)
  return total === 0 ? '' : `Step ${Math.min(Math.max(sub, 1), total)} / ${total}`
}

/**
 * ②Step3・Step4で利用者に確かめてもらう印。
 * LINE には「Webhook の利用／再送／エラーの統計情報」「友だち追加オプションのリンク」
 * 「公開済み化」を書き換える API が無いので、musubo からは設定できない。手で入れてもらう。
 */
export interface AckItem { key: string; label: string; note: string }
export const WEBHOOK_ACKS: ReadonlyArray<AckItem> = [
  /* 承認済み v07（LINE新規追加_v07.pen・2026-10-18承認）で足した印（dqe2M）。
     URLを貼って「更新」を押すまで、LINE側に下の3つのスイッチが出てこない。 */
  { key: 'webhookUrlPasted', label: 'Webhook URL を貼り付けて「更新」を押した', note: '貼り付けて更新しないと、下の3つのスイッチが表示されません。' },
  { key: 'webhookUse', label: 'Webhookの利用をONにした', note: 'OFFのままだと、お客さまのメッセージが musubo に届きません。' },
  { key: 'webhookRedelivery', label: 'Webhookの再送をONにした', note: '通信が一時的に失敗したとき、LINEが送り直してくれます。' },
  { key: 'webhookErrorStats', label: 'エラーの統計情報をONにした', note: '届かなかったときの原因が分かるようになります。' },
]
export const LOGIN_ACKS: ReadonlyArray<AckItem> = [
  { key: 'addFriendLink', label: '友だち追加オプションで、この公式アカウントをリンクした', note: 'ここをつないでおくと、musubo が作る友だち追加の窓口が正しく動きます。' },
  { key: 'published', label: 'チャネルを「開発中」から「公開済み」にした', note: '開発中のままだと、お客さま側でログインの画面が開きません。' },
]

/** 印がすべて入っているか。1つでも残っていれば次の段へ進めない。 */
export function allAcked(acks: ReadonlyArray<{ key: string }>, checked: Record<string, boolean>): boolean {
  return acks.every((ack) => checked[ack.key] === true)
}

/**
 * 承認済み v07 の「musubo の Webhook URL」（Ds3E2 の vnh17）に出す字。
 * 受け取り口は apps/worker の expectedWebhookUrl と同じ `<APIの元>/webhook/<Messaging APIチャネルID>`。
 * 元や数字のチャネルIDが未設定のときは字を作らない（画面側で「不明」を出す）。
 */
export function musuboWebhookUrl(channelId: string): string {
  const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '')
  const id = channelId.trim()
  return base && /^\d+$/.test(id) ? `${base}/webhook/${id}` : ''
}

/** LINE Developers の Messaging API 設定画面。数字のチャネルIDがあるときだけリンクする。 */
export function developerChannelUrl(channelId: string): string {
  const id = channelId.trim()
  return /^\d+$/.test(id) ? `https://developers.line.biz/console/channel/${id}/messaging-api` : ''
}

/** LINE Developers のプロバイダー画面。チャネルIDからは組み立てられない。 */
export function developerProviderUrl(providerId: string): string {
  const id = providerId.trim()
  return /^\d+$/.test(id) ? `https://developers.line.biz/console/provider/${id}` : ''
}


/* 切り出した先。読む側の import を変えないよう、ここからそのまま出し直す。 */
export * from './precheck'
export * from './connection-check'
export * from './check-rows'
