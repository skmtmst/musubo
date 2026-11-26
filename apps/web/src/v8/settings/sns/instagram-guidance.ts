/**
 * 設定 › SNS 連携の Instagram の案内。お店が画面の案内だけでつなげるように、
 * つなぐ前に確かめること・行ごとの対処・ログインから戻ったときの知らせをここにまとめる。
 *
 * 決まり：
 * - つなぎ方は Instagram に直接ログインする方式。Facebook ページは使わない。
 * - 失敗の種類名（URL の `instagram_code`）は画面に出さず、種類ごとの対処の1行だけを出す。
 *   知らない種類名は、ふつうの失敗の案内にまとめる。
 * - 対処の文は「何が起きたか＋どうすれば直るか」を1行で書く。
 */
import type { SnsConnectionView } from './connection-slots'

/** 未接続の段の押しボタン。押すと先に案内の窓を開く。 */
export const INSTAGRAM_CONNECT_LABEL = 'Instagram をつなぐ'

/** 行と知らせの押しボタン。ログインをやり直して許可を取り直す。 */
export const INSTAGRAM_RECONNECT_LABEL = 'もう一度つなぐ'

/** 案内の窓から Instagram のログイン画面へ進む押しボタン。 */
export const INSTAGRAM_PROCEED_LABEL = 'Instagram へ進む'

/** カードの下に出す、つなぐための条件の1行。 */
export const INSTAGRAM_REQUIREMENT_NOTE =
  'プロアカウント（ビジネスまたはクリエイター）でつなぎます。Facebook ページは要りません。'

/** 案内の窓の説明。ログインのあとこの画面へ戻ることを先に伝える。 */
export const INSTAGRAM_GUIDE_LEAD =
  '次の画面で Instagram にログインして、許可を進めます。終わるとこの画面に戻り、接続済みになります。'

/** つなぐ前に確かめること（案内の窓の3項目）。 */
export const INSTAGRAM_CONNECT_CHECKS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'プロアカウントでつなぎます',
    detail: 'ビジネスまたはクリエイターのアカウントが必要です。個人のアカウントは、Instagram アプリの設定でプロアカウントに切り替えてください（無料）。',
  },
  {
    title: 'Facebook ページは要りません',
    detail: 'Instagram にログインするだけでつながります。',
  },
  {
    title: 'DM の許可はオンのまま進めます',
    detail: '許可の画面で DM の項目を外すと、受信箱で DM を読んだり返したりできません。',
  },
]

/** 行の対処の種類。札の色に合わせて印の色を選ぶ（切れている＝赤、許可が足りない＝注意）。 */
export type InstagramRowRemedy = { tone: 'danger' | 'warn'; text: string }

/** 行に出す対処の1行。もう一度つなげば直る行だけに出し、ほかの行は null。 */
export function instagramRowRemedy(connection: SnsConnectionView): InstagramRowRemedy | null {
  if (connection.state === 'expired') {
    return { tone: 'danger', text: '接続が切れています。もう一度つなぐと、元どおり使えます。' }
  }
  if (connection.dmPermissionMissing) {
    return { tone: 'warn', text: 'DM の許可がありません。もう一度つないで、DM の許可をオンにしてください。' }
  }
  return null
}

/** ログインから戻ったときの知らせ。`retry` は［もう一度つなぐ］で直せる失敗か。 */
export type InstagramReturnNotice = { tone: 'success' | 'danger'; text: string; retry: boolean }

/** 失敗の種類（URL の `instagram_code`）ごとの対処。 */
const FAILURES = new Map<string, Omit<InstagramReturnNotice, 'tone'>>([
  ['instagram_business_account_required', {
    text: '個人のアカウントはつなげません。Instagram アプリでプロアカウントに切り替えてから、もう一度つないでください。',
    retry: true,
  }],
  ['instagram_webhook_subscription_failed', {
    text: 'DM を受け取る設定ができませんでした。少し時間をおいて、もう一度つないでください。',
    retry: true,
  }],
  ['instagram_publish_not_granted', {
    text: '許可の画面で外された項目があります。項目を外さずに、もう一度つないでください。',
    retry: true,
  }],
  ['instagram_login_denied', {
    text: 'Instagram の画面で許可されませんでした。もう一度つないで、許可してください。',
    retry: true,
  }],
  ['instagram_account_already_connected', {
    text: 'この Instagram は、すでにこのLINEアカウントにつながっています。別のアカウントをつなぐときは、Instagram でそのアカウントにログインしてください。',
    retry: false,
  }],
  ['instagram_account_other_organization', {
    text: 'このInstagramは別の統括で使用されています。統括の管理者に確認してください。',
    retry: false,
  }],
])

/** 種類の分からない失敗。いちばん多い原因（アカウントの種類）を確かめてもらう。 */
const FAILURE_FALLBACK: Omit<InstagramReturnNotice, 'tone'> = {
  text: 'Instagram とつなげませんでした。プロアカウント（ビジネスまたはクリエイター）でログインしているか確かめて、もう一度つないでください。',
  retry: true,
}

/** 戻り先（`/settings/sns?instagram=…`）の印から知らせを決める。印が無ければ null。 */
export function instagramReturnNotice(params: URLSearchParams): InstagramReturnNotice | null {
  const result = params.get('instagram')
  if (result === 'connected') return { tone: 'success', text: 'Instagram とつながりました。', retry: false }
  if (result !== 'failed') return null
  return { tone: 'danger', ...(FAILURES.get(params.get('instagram_code') ?? '') ?? FAILURE_FALLBACK) }
}
