/**
 * 設定 › メール・SNS連携の「メール」の枠で使う、画面を持たない決まり。
 * 状態の言葉と色は `status-labels` の表が持ち、ここでは作らない。
 */
import { ApiError, type AccountEmailIssue, type AccountEmailStatus } from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'

/** 転送の設定が生きている状態。新しいアドレスの発行（409）と解除の対象になる。 */
export function isActiveEmailConnection(status: AccountEmailStatus | null | undefined): boolean {
  return status === 'setup' || status === 'pending' || status === 'connected'
}

/** 転送の確かめが続いている間。届いた確認コードや状態の変化を読み直す。 */
export function isWaitingEmailConnection(status: AccountEmailStatus | null | undefined): boolean {
  return status === 'setup' || status === 'pending'
}

const MAILBOX_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** お店のメールアドレスの欄の誤り。正しいときは空文字。 */
export function mailboxInputError(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'お店のメールアドレスを入力してください。'
  if (trimmed.length > 254 || !MAILBOX_PATTERN.test(trimmed)) return 'メールアドレスの形で入力してください（例：shop@example.com）。'
  return ''
}

/**
 * Gmail・Yahoo!メールなどが転送先へ送る確認の文字。数字だけなら確認コード、https で始まれば確認用の URL。
 * どちらも文字として見せるだけで、リンクにはしない。
 */
export type ForwardingConfirmationView = { kind: 'code' | 'url' | 'text'; text: string }

export function forwardingConfirmationView(value: string | null | undefined): ForwardingConfirmationView | null {
  const text = value?.trim() ?? ''
  if (!text) return null
  if (/^\d{4,12}$/.test(text)) return { kind: 'code', text }
  if (/^https:\/\/\S+$/i.test(text)) return { kind: 'url', text }
  return { kind: 'text', text }
}

/** 接続の操作に失敗したときの文。発行の 409 は、すでにアドレスがあることを伝える。 */
export function emailConnectionFailureMessage(error: unknown, action: 'issue' | 'verify' | 'disconnect'): string {
  if (action === 'issue' && error instanceof ApiError && error.status === 409) {
    return 'このアカウントには、すでに転送用アドレスがあります。新しく発行するときは、今の接続を解除してからにしてください。'
  }
  return describeApiFailure(error, action === 'issue' ? '転送用アドレスの発行' : action === 'verify' ? '確認メールの送信' : '接続の解除')
}

/**
 * 詰まりの題と直し方。画面はこの文を出すだけで、判定はサーバーが持つ。
 * 確認の期限切れは、一度つながった店（最後に確かめた日時がある・接続済み）なら転送が止まった疑いとして案内する。
 */
export function emailIssueCopy(
  issue: AccountEmailIssue | null | undefined,
  { wasConnected }: { wasConnected: boolean },
): { title: string; fix: string } | null {
  if (issue === 'confirmation_delayed') {
    return {
      title: '確認メールが届いていません',
      fix: '送ってから5分たっても届いていません。お店のメールの転送先が転送用アドレスになっているか、転送が有効になっているかを確かめてください。確認メールがお店のメールの迷惑メールに入っていると転送されないので、入っていたら迷惑メールではない印を付けてから、確認メールを送り直してください。',
    }
  }
  if (issue === 'verification_expired') {
    return wasConnected
      ? {
        title: '転送を確認できません',
        fix: '受信の確認の期限が切れました。お店のメールの転送の設定が止まっていないか、転送先が転送用アドレスのままかを確かめてから、［受信を再確認する］を押してください。確認が済むまで、届いたメールはこれまでどおり受信箱に入ります。',
      }
      : {
        title: '確認の期限が切れました',
        fix: '確認メールを送ってから時間がたちすぎました。お店のメールの転送の設定を確かめてから、確認メールを送り直してください。',
      }
  }
  if (issue === 'automated_mail') {
    return {
      title: '自動で送られたメールが届いています',
      fix: '自動返信・不在のお知らせ・配信エラーなどの自動のメールは、受信箱に取り込みません。お店のメールの自動返信や転送の設定が、転送用アドレスへ向いていないかを確かめてください。',
    }
  }
  return null
}

export type ForwardingProvider = 'gmail' | 'outlook' | 'yahoo' | 'other'

export const FORWARDING_PROVIDERS: { value: ForwardingProvider; label: string }[] = [
  { value: 'gmail', label: 'Gmail' },
  { value: 'outlook', label: 'Outlook' },
  { value: 'yahoo', label: 'Yahoo!メール' },
  { value: 'other', label: 'そのほか' },
]

/** お店のメールで転送を設定する手順（数行）。確認コードはこの枠に出るので、そこからコピーしてもらう。 */
export function forwardingSteps(provider: ForwardingProvider): string[] {
  if (provider === 'gmail') {
    return [
      'パソコンで Gmail を開き、右上の歯車 →［すべての設定を表示］→［メール転送と POP/IMAP］を開きます。',
      '［転送先アドレスを追加］に転送用アドレスを貼り付け、［次へ］→［続行］→［OK］を押します。',
      'この枠に届く確認コードをコピーし、Gmail の確認コードの欄に貼り付けて［確認］を押します。',
      '［受信メールを…に転送して］を選び、Gmail のメールは受信トレイに残したまま［変更を保存］を押します。',
    ]
  }
  if (provider === 'outlook') {
    return [
      'Outlook（ブラウザ版）の右上の歯車 →［メール］→［ルール］→［新しいルールを追加］を開きます。',
      '条件は［すべてのメッセージに適用］、アクションは［リダイレクト先］を選び、転送用アドレスを貼り付けて［保存］を押します。',
      '［転送先］ではなく［リダイレクト先］にすると、元の差出人のまま届きます。会社のメール（Microsoft 365）は、管理者が外への転送を止めていることがあります。',
    ]
  }
  if (provider === 'yahoo') {
    return [
      'Yahoo! JAPAN のメールアドレス情報のページで、「連絡用メールアドレス」に転送用アドレスを貼り付けて［追加］→［送信］を押します。',
      'この枠に届く確認コードをコピーし、確認コードの欄に貼り付けて［登録］を押します。',
      'Yahoo!メールのメール一覧の右上の設定ボタンからメール転送のページを開き、「自動転送を有効にする」に印を付けて転送用アドレスを入れ、［保存］を押します。',
      '転送したメールは Yahoo!メールに残りません。IMAP/POP/SMTP のアクセス機能とは一緒に使えません。',
    ]
  }
  return [
    'お使いのメール（レンタルサーバー・プロバイダーなど）の管理画面で、転送の設定を開きます。',
    '転送先に転送用アドレスを貼り付けて保存します。お店のメールボックスにも残す設定があれば、残すほうを選びます。',
  ]
}
