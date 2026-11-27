'use client'

/*
 * 共通の「送る前の確かめ」窓（板 F94nep の 6 つの状態・RxxfO ほか）。
 * 送る所（一斉配信・統括の一括配信・A/B の残り・ランクの知らせ・自動で答えるのオン）は、
 * この窓の中身（人数・目的・日時・送り手・本文の頭）を渡すだけで同じ形・同じ言葉で使う。
 *
 * 決まり（U1）：
 * - 送ったあとは取り消せない。取り消せる振りの言葉（元に戻す 等）は出さない。訂正は［訂正を送る］。
 * - 窓の外を押しても閉じない（Esc と［戻る］だけ閉じる＝送らない）。
 * - 主ボタンは押したらすぐ押せなくなる（二重送信を防ぐ）。
 * - 人数が数えられていない・0 人・権限が無い・代理ログイン中は主ボタンを出さない／押せない。
 */
import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Send, ShieldAlert } from 'lucide-react'
import ConfirmDialog from './confirm-dialog'
import Button from './button'
import Notice from './notice'
import { Skeleton } from './skeleton'
import { formatNumber } from '@/lib/format'
import styles from './send-confirm-dialog.module.css'

export type SendPurpose = 'transaction' | 'notice' | 'marketing'

const PURPOSE_LABEL: Record<SendPurpose, string> = { transaction: '取引（予約・注文の連絡）', notice: 'お知らせ', marketing: '宣伝' }

/** 「10/18 10:00」の短い日時（予約ボタン用）。日本時間。 */
export function shortWhen(iso: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`
}

/** 送る相手の補足「対象 1,284 人から除く 12 人：宣伝を止めている 12・ブロック 0・重複 0」。 */
export function describeExclusion(recipients: number, excluded: { blocked: number; optedOut: number; duplicate: number; hidden?: number; missingDestination?: number }): string {
  const other = (excluded.hidden ?? 0) + (excluded.missingDestination ?? 0)
  const total = excluded.blocked + excluded.optedOut + excluded.duplicate + other
  const parts = [`宣伝を止めている ${formatNumber(excluded.optedOut)}`, `ブロック ${formatNumber(excluded.blocked)}`, `重複 ${formatNumber(excluded.duplicate)}`, ...(other > 0 ? [`ほか ${formatNumber(other)}`] : [])]
  if (recipients === 0 && total > 0 && excluded.optedOut === total) return `対象 ${formatNumber(total)} 人はすべて宣伝を止めています`
  return `対象 ${formatNumber(recipients + total)} 人から除く ${formatNumber(total)} 人：${parts.join('・')}`
}

/** 夜の静かな時間でずらした送信時刻「10/19（日）8:00」。日本時間。 */
export function shiftedWhen(iso: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const ymd = (d: Date) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(d)
  const prefix = ymd(new Date(iso)) === ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000)) ? '明日 ' : ''
  return `${prefix}${get('month')}/${get('day')}（${get('weekday')}）${get('hour')}:${get('minute')}`
}

/** 送る日が日本時間の「明日」なら「明日 8:00」、そうでなければ「10/19 8:00」（主ボタン用）。 */
export function shiftedShort(iso: string, now: Date = new Date()): string {
  const ymd = (d: Date) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' }).format(d)
  const at = new Date(iso)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const hm = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit', hour12: false }).format(at)
  return ymd(at) === ymd(tomorrow) ? `明日 ${hm}` : `${shortWhen(iso).split(' ')[0]} ${hm}`
}

export type SendConfirmBlock = 'no-permission' | 'impersonation' | null

export interface SendConfirmDialogProps {
  open: boolean
  /** 窓の見出しの下の 1 行（例「新しい一斉配信 ・ 絞り込みで送る」）。 */
  subtitle: string
  /** 予約・承認待ちのときの見出し「予約する前の確かめ」。 */
  scheduled?: boolean
  /** 読み込み中（数が出るまで主ボタンは押せない）／数えられなかった／読めた。 */
  state: 'loading' | 'error' | 'ready'
  onRetry?: () => void
  /** 送る人数。0 は「送る相手が 0 人です」。 */
  recipients: number | null
  /** 人数の下の 1 行（除外の内訳・「友だち全員」など）。 */
  recipientsNote?: string
  /** 統括：店ごとの内訳（合計との差は画面側で出さない）。 */
  perAccount?: Array<{ name: string; recipients: number; stopped: number; narrowed?: boolean }>
  /** 統括：送るアカウントの数（「12 アカウント ・ 合計 15,131 人」の題に使う）。 */
  accountCount?: number
  purpose: SendPurpose
  /** 日時の表示（「10/18（土）10:00 に送る（予約）」「今すぐ送る」）。 */
  whenLabel: string
  /** 日時の下の 1 行（予約の取り消しの案内・夜の静かな時間のずらし）。 */
  whenNote?: string
  /** 送り手（G8）。無ければ行を出さない。 */
  sender?: { name: string; iconUrl?: string | null } | null
  bodyHead: string
  bubbleCount?: number
  /** 自動で答える版：本文の行の見出しを差し替える。 */
  bodyLabel?: string
  /** 全員への配信は、送り始めると途中で止められない（1 行足す）。 */
  allRecipients?: boolean
  /** 自動で送る版の注意（「自動で送った答えは取り消せません…」）。 */
  extraCaution?: string
  /** 承認が要る（1,000 人以上など）。主ボタンは［承認を依頼する］。 */
  approval?: { note: string } | null
  /** 承認が要るとき、窓の中に出す欄（承認する人・ひとこと）。 */
  approvalFields?: ReactNode
  /** 承認と独立した、送信前の確認欄。指定しない用途の表示は変えない。 */
  confirmationFields?: ReactNode
  /** 承認する人が選ばれるまで主ボタンを押せなくする。 */
  primaryDisabled?: boolean
  block?: SendConfirmBlock
  /** 送る口がまだ使えない（承認の設定を読めていない 等）。主ボタンごと出さない。 */
  hidePrimary?: boolean
  /** 主ボタンを出せない理由（承認の設定を読めない 等）。 */
  unavailableNote?: string
  /** 主ボタンの文言（「1,272 人に予約する」「承認を依頼する」…）。 */
  primaryLabel: string
  /** 押したら送る。戻るまで主ボタンは押せない。 */
  onConfirm: () => Promise<void> | void
  onBack: () => void
  error?: string
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  )
}

export default function SendConfirmDialog(props: SendConfirmDialogProps) {
  const {
    open, subtitle, scheduled, state, onRetry, recipients, recipientsNote, perAccount, accountCount, purpose, whenLabel, whenNote, sender,
    bodyHead, bubbleCount, bodyLabel = '本文', allRecipients, extraCaution, approval, approvalFields, confirmationFields, primaryDisabled, block, hidePrimary, unavailableNote, primaryLabel, onConfirm, onBack, error,
  } = props
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const validCount = typeof recipients === 'number' && Number.isSafeInteger(recipients) && recipients >= 0
  const validBreakdown = !perAccount?.length || (perAccount.every(row => Number.isSafeInteger(row.recipients) && row.recipients >= 0 && Number.isSafeInteger(row.stopped) && row.stopped >= 0) && perAccount.reduce((total, row) => total + row.recipients, 0) === recipients)
  const countError = state === 'error' || (state === 'ready' && (!validCount || !validBreakdown))
  const zero = state === 'ready' && recipients === 0
  const canPress = state === 'ready' && validCount && validBreakdown && !zero && !block && !busy && !primaryDisabled
  const [accountsOpen, setAccountsOpen] = useState(true)

  const confirm = async () => {
    if (submitting.current || !canPress) return
    submitting.current = true
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  const blockText = block === 'impersonation'
    ? '代理ログイン中は送れません。'
    : block === 'no-permission' ? '送るには権限が要ります（頼む先：管理者）。' : null

  return (
    <ConfirmDialog
      open={open}
      title={scheduled ? '予約する前の確かめ' : '送る前の確かめ'}
      titleIcon={false}
      confirmIcon={<Send size={16} aria-hidden="true" />}
      description={subtitle}
      confirmLabel={countError ? (approval ? '承認を依頼する' : scheduled ? '予約する' : '送る') : primaryLabel}
      busyLabel="送っています…"
      cancelLabel="戻る"
      busy={busy}
      error={error}
      size="large"
      actionWidthReserve="idle"
      onConfirm={blockText || hidePrimary ? undefined : confirm}
      confirmDisabled={!canPress}
      onCancel={() => { if (!busy) onBack() }}
      designNode="F94nep"
      designTop={64}
      footerLead={<span className={styles.footLead}>閉じても送りません</span>}
    >
      <dl className={styles.rows} aria-busy={state === 'loading' || undefined}>
        <Row label="送る相手">
          {state === 'loading' ? <Skeleton width={96} height={18} /> : countError ? (
            <div className={styles.stack}>
              <strong className={styles.strong}>人数を数えられませんでした</strong>
              <span className={styles.note}>通信を確かめて、もう一度数えてください</span>
              {onRetry ? <Button size="compact" onClick={onRetry}>もう一度数える</Button> : null}
            </div>
          ) : zero ? (
            <div className={styles.stack}>
              <strong className={styles.strong}>送る相手が 0 人です</strong>
              {recipientsNote ? <span className={styles.note}>{recipientsNote}</span> : null}
            </div>
          ) : (
            <div className={styles.stack}>
              <strong className={styles.big}>{perAccount?.length && accountCount ? `${formatNumber(accountCount)} アカウント・合計 ${formatNumber(recipients ?? 0)} 人` : `${formatNumber(recipients ?? 0)} 人`}</strong>
              {recipientsNote ? <span className={styles.note}>{recipientsNote}</span> : null}
              {approval ? <span className={styles.note}>{approval.note}</span> : null}
              {perAccount?.length ? (
                <div className={styles.accountsBox}>
                  <button type="button" className={styles.accountsHead} aria-expanded={accountsOpen} onClick={() => setAccountsOpen((v) => !v)}>
                    {accountsOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                    {accountsOpen ? '店ごとの内訳を畳む' : '店ごとの内訳を開く'}
                    <span className={styles.accountsCols}>送る人 ／ 止めている人</span>
                  </button>
                  {accountsOpen ? (
                    <ul className={styles.accounts}>
                      {perAccount.map((row) => (
                        <li key={row.name}><span>{row.name}{row.narrowed ? '（絞り込み）' : ''}</span><span className={styles.accountsNum}>{formatNumber(row.recipients)} 人</span><span className={styles.accountsNum}>{formatNumber(row.stopped)} 人</span></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </Row>
        <Row label="送る目的">
          <div className={styles.stack}>
            <strong className={styles.purpose}>{PURPOSE_LABEL[purpose]}</strong>
            {purpose === 'marketing' ? <span className={styles.note}>宣伝を止めている人には送りません</span> : null}
          </div>
        </Row>
        <Row label="送る日時">
          <div className={styles.stack}>
            <strong className={styles.strong}>{whenLabel}</strong>
            {whenNote ? <span className={styles.note}>{whenNote}</span> : null}
          </div>
        </Row>
        {sender ? (
          <Row label="送り手">
            <span className={styles.sender}>
              {sender.iconUrl
                // eslint-disable-next-line @next/next/no-img-element -- 送り手のアイコン（同じ店の登録メディア）
                ? <img width={24} height={24} src={sender.iconUrl} alt="" className={styles.senderIcon} />
                : <span className={styles.senderIcon} aria-hidden="true">{sender.name.slice(0, 1)}</span>}
              <strong className={styles.strong}>{sender.name}</strong>
            </span>
          </Row>
        ) : null}
        <Row label={bodyLabel}>
          <div className={styles.stack}>
            <span className={styles.body}>{bodyHead}</span>
            {bubbleCount ? <span className={styles.note}>吹き出し {bubbleCount} つ</span> : null}
          </div>
        </Row>
        {approval && approvalFields ? <Row label="承認する人">{approvalFields}</Row> : null}
      </dl>
      {confirmationFields}
      <Notice tone="warn" heading="送ったあとは取り消せません。">
        <p>間違いに気づいたら、送ったあとに［訂正を送る］で正しい内容を送れます。</p>
        {extraCaution ? <p>{extraCaution}</p> : null}
        {allRecipients ? <p>全員への配信は、送り始めると途中で止められません。</p> : null}
      </Notice>
      {unavailableNote ? <div className={styles.blocked} role="status">{unavailableNote}</div> : null}
      {blockText ? (
        <div className={styles.blocked} role="status"><ShieldAlert size={16} aria-hidden="true" />{blockText}</div>
      ) : null}
    </ConfirmDialog>
  )
}
