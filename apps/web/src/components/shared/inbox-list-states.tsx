import { Mail, MessageCircle } from 'lucide-react'
import { InstagramMark } from './brand-marks'
import Button from './button'
import ListState from './list-state'
import Notice from './notice'

/**
 * 受信箱の一覧の空と失敗。ほかの一覧と同じ形（空は印・題・説明、失敗は知らせ1つ・もう一度読み込む1つ）。
 * 会話とメールが両方失敗しても、知らせとボタンは1つにまとめる（押せば失敗した物を全部読み直す）。
 * 知らせには「何が読めて何が読めないか」を書く。読めた方の一覧はそのまま使える。
 */
export function InboxListEmpty({
  filtered,
  onClear,
  channel = 'all',
  unconfigured = false,
}: {
  filtered: boolean
  onClear: () => void
  channel?: 'all' | 'line' | 'instagram' | 'email'
  unconfigured?: boolean
}) {
  const icon = filtered
    ? <MessageCircle aria-hidden="true" size={20} />
    : channel === 'instagram'
      ? <InstagramMark size={20} />
      : channel === 'email'
        ? <Mail aria-hidden="true" size={20} />
        : <MessageCircle aria-hidden="true" size={20} />
  const title = filtered
    ? '条件に一致する会話がありません'
    : unconfigured && channel === 'instagram'
      ? 'Instagram はまだつながっていません'
      : unconfigured && channel === 'email'
        ? 'メールはまだ設定されていません'
        : 'まだ会話がありません'
  const description = filtered
    ? '条件を変えるか、絞り込みを外してください。'
    : unconfigured && channel === 'instagram'
      ? 'Instagram をつなぐと、DM がここに届きます。'
      : unconfigured && channel === 'email'
        ? 'メールを設定すると、問い合わせメールがここに届きます。'
        : channel === 'email'
          ? 'メールが届くとここに出ます。'
          : 'LINE で話しかけられるとここに出ます。'
  return (
    <div data-inbox-list-state={filtered ? 'filtered-empty' : 'empty'}>
      <ListState
        kind="empty"
        emptyPreset={filtered ? 'filtered' : 'readonly'}
        icon={icon}
        title={title}
        description={description}
        action={filtered ? <Button onClick={onClear}>絞り込みを外す</Button> : undefined}
      />
    </div>
  )
}

export type InboxSource = 'line' | 'email'
const SOURCE_NAME: Record<InboxSource, string> = { line: 'LINE の会話', email: 'メール' }

/** 読めなかった物と、読めている物を 1 つの文にする。 */
export function inboxFailureText(failed: readonly InboxSource[], shown: readonly InboxSource[]): string | null {
  if (failed.length === 0) return null
  const lost = failed.map((source) => SOURCE_NAME[source]).join('と')
  const fine = shown.filter((source) => !failed.includes(source)).map((source) => SOURCE_NAME[source]).join('と')
  return `${lost}を読み込めませんでした。読み込めていないため件数は分かりません。${fine ? `${fine}は読めています。` : ''}`
}

export function InboxListFailure({ failed, shown, detail, onRetry }: { failed: readonly InboxSource[]; shown: readonly InboxSource[]; detail?: string; onRetry: () => void }) {
  const text = inboxFailureText(failed, shown)
  if (!text) return null
  return (
    <div data-inbox-list-failure="">
      <Notice tone="danger" role="alert" action={<Button size="field" onClick={onRetry}>もう一度読み込む</Button>}>
        <p>{text}</p>
        {detail ? <p>{detail}</p> : null}
      </Notice>
    </div>
  )
}
