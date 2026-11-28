import type { LineAccountConnectData, LineAccountConnectVerification } from '@/lib/api'

export type CheckState = 'passed' | 'failed' | 'skipped'
export interface CheckStep { order: number; message: string; state: CheckState }

/** 返事を設計の5段に並べ直す。返事が無ければ5段とも「確かめていません」。 */
export function toSteps(result: { steps: CheckStep[] } | null): CheckStep[] {
  const messages = [
    'チャネルIDとシークレットでアクセストークンを発行',
    '公式アカウントの名前とアイコンを取得',
    'Webhook URLを登録して、実際に届くかテスト',
    'LINE Loginチャネルを確認して、LIFFアプリを作成',
    '認証済みアカウントかを判定',
  ]
  if (!result || !Array.isArray(result.steps)) {
    return messages.map((message, i) => ({ order: i + 1, message, state: 'skipped' as const }))
  }
  return result.steps.map((item, i) => (
    item && typeof item === 'object'
      ? { ...item }
      : { order: i + 1, message: messages[i] ?? '', state: 'skipped' as const }
  ))
}

/** 保存してよいか。5段すべて通ったときだけ保存する。 */
export function canSave(steps: CheckStep[]): boolean {
  return Array.isArray(steps) && steps.length >= 5 && steps.every((s) => Boolean(s) && s.state === 'passed')
}

export type CheckRowState = 'passed' | 'failed' | 'todo'
export interface V8CheckRow {
  key: 'channel' | 'provider' | 'webhook' | 'lineId' | 'addUrl'
  title: string
  detail: string
  state: CheckRowState
  message: string | null
}

export function webhookDetail(webhook: LineAccountConnectVerification['webhook'] | undefined, checked: boolean, passed: boolean): string {
  if (!checked) return '「接続して設定する」を押すと確かめます'
  if (passed) return 'musubo の受け口へ届きました'
  if (webhook && webhook.registeredUrl !== null && webhook.registeredUrl !== webhook.expectedUrl) return '登録先が musubo の受け口と違います'
  if (webhook && webhook.active === false) return 'LINE Developers で「Webhook の利用」がオフです。オンにしてから押し直してください'
  return '受け口へ届きませんでした'
}

/** ④の5行。検査前はすべて「まだ」。内訳（verification）が無い古い応答は5段の合否から作る。 */
export function toV8CheckRows(connection: LineAccountConnectData | null): V8CheckRow[] {
  const steps = toSteps(connection ? { steps: connection.steps } : null)
  const verification = connection?.verification
  const webhookChecked = Boolean(connection) && steps[2] !== undefined && steps[2].state !== 'skipped'
  const webhookPassed = Boolean(connection) && steps[2]?.state === 'passed'
  const channelPassed = verification ? verification.tokenOk && verification.loginOk : steps[0]?.state === 'passed' && steps[3]?.state === 'passed'
  const channelFailed = Boolean(connection) && !channelPassed && (steps[0]?.state === 'failed' || steps[3]?.state === 'failed')
  const providerPassed = verification ? verification.sameProvider : channelPassed
  const providerFailed = Boolean(connection) && !providerPassed && (steps[0]?.state === 'failed' || steps[3]?.state === 'failed')
  const basicId = typeof connection?.basicId === 'string' && connection.basicId.trim() !== '' ? connection.basicId.trim() : null
  const lineIdState: CheckRowState = connection && webhookPassed && basicId ? 'passed' : 'todo'
  const addUrlState: CheckRowState = connection && webhookPassed && basicId ? 'passed' : 'todo'
  return [
    {
      key: 'channel', title: 'チャネル ID とシークレット', detail: 'Messaging API・LINE Login とも認証済み',
      state: !connection ? 'todo' : channelPassed ? 'passed' : channelFailed ? 'failed' : 'todo',
      message: channelFailed ? (steps[0]?.state === 'failed' ? steps[0].message : steps[3]?.message ?? null) : null,
    },
    {
      key: 'provider', title: '2つのチャネルの認証', detail: 'Messaging API・LINEログインの認証結果',
      state: !connection ? 'todo' : providerPassed ? 'passed' : providerFailed ? 'failed' : 'todo',
      message: providerFailed ? 'チャネルID・シークレットを確認してください。' : null,
    },
    {
      key: 'webhook', title: 'Webhook', detail: webhookDetail(verification?.webhook, webhookChecked, webhookPassed),
      state: !connection || !webhookChecked ? 'todo' : webhookPassed ? 'passed' : 'failed',
      message: !connection || !webhookChecked || webhookPassed ? null : (steps[2]?.message ?? null),
    },
    { key: 'lineId', title: 'LINE ID の取得', detail: lineIdState === 'passed' && basicId ? basicId : '3 が通ると確かめます', state: lineIdState, message: null },
    { key: 'addUrl', title: '友だち追加 URL', detail: addUrlState === 'passed' && basicId ? `https://line.me/R/ti/p/@${basicId.replace(/^@/, '')}` : '3 が通ると確かめます', state: addUrlState, message: null },
  ]
}

/**
 * ④の行に出す説明。止まった行は「なぜ止まったか」を1つだけ出す（同じことを2回書かない）。
 * Webhook は内訳から作った説明（オフ・登録先違い）がそのまま理由なので、段の文を重ねない。
 * 内訳が無いときだけ段の文を括弧で足す。チャネル・プロバイダーは「認証済み」の説明を出さず理由を出す。
 */
export function checkRowText(row: V8CheckRow): string {
  if (row.state !== 'failed' || !row.message) return row.detail
  if (row.key === 'webhook') return row.detail === '受け口へ届きませんでした' ? `${row.detail}（${row.message}）` : row.detail
  return row.message
}

export function allV8RowsPassed(rows: V8CheckRow[]): boolean {
  return Array.isArray(rows) && rows.length >= 5 && rows.every((row) => Boolean(row) && row.state === 'passed')
}
