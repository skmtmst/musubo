'use client'
import { Clock3, FileText } from 'lucide-react'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DateTimeField from '@/components/shared/date-time-field'
import FilterChip from '@/components/shared/filter-chip'
import { isNightJst, schedulePresets, shortJst } from './schedule-presets'
import styles from './inbox-chat.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { scheduledMessageInputReason } from '@/lib/scheduled-message-input'
import { InsertText } from '@/components/shared/insert-text-field'
import { insertDisplayText, type InsertTokenNames } from '@/components/shared/insert-tokens'
import { CHAT_INSERT_TOKENS } from './chat-inserts'


/*
 * ★V8「予約して送る」（ 段2「6. 予約して送る（書く欄から・テンプレートと画像も）」）。
 *
 * 前は書く欄の上に「送る日時 ［日時を選ぶ］［この日時で予約する］」の段が出ていた
 * （オーナー指摘：嫌）。書く欄の下の［予約］から窓で開く。送るもの・すぐ選ぶ・
 * 日時を決める・夜中の注意・予約中の一覧（時刻を直す・取り消す）を1つの窓に置く。
 * 予約そのものの動き（口・二度押し止め・日本時間）は画面側の今の処理をそのまま呼ぶ。
 */

export type ScheduledRowView = {
  id: string
  /** 送る日時（日本時間で読める形） */
  label: string
  content: string
  /** 予約中だけ直せる・取り消せる（送信中・送信済みは不可） */
  editable: boolean
  /** 時刻を直す欄の初期値（日本時間の datetime-local） */
  defaultValue: string
  /** 送る時刻の 1 分前を過ぎた（Q-38）。取り消せず「まもなく送ります」と出す。 */
  tooLate?: boolean
}

export default function ScheduleSendDialog({
  open,
  accountId,
  targetStale = false,
  onClose,
  content,
  hasImage,
  attachmentLabel,
  value,
  onChange,
  onConfirm,
  busy,
  error,
  rows,
  rowsFailed,
  onRetryRows,
  onReschedule,
  onCancelRow,
  now,
  tokenNames = {},
}: {
  open: boolean
  accountId: string | null
  targetStale?: boolean
  onClose: () => void
  /** 書く欄の本文（送るもの） */
  content: string
  hasImage: boolean
  /** ：準備済みの動画・ファイル（例：動画「説明.mp4」）。無いときは出さない。 */
  attachmentLabel?: string
  /** 日本時間の datetime-local */
  value: string
  onChange: (next: string) => void
  onConfirm: () => void
  busy: boolean
  error?: string
  rows: ScheduledRowView[]
  rowsFailed: boolean
  onRetryRows: () => void
  onReschedule: (id: string, next: string) => void
  onCancelRow: (id: string) => void
  /** 試験で「いま」を固定する */
  now?: Date
  /** 差し込みの札の名前（返信欄と同じ札で読む。送る値は {{…}} のまま）。 */
  tokenNames?: InsertTokenNames
}) {
  const presets = schedulePresets(now)
  const firstLine = content.trim().split('\n')[0] ?? ''
  /* 差し込みは札で見せ、title も札の名前で読む（生の {{…}} を出さない）。 */
  const inserts = { names: tokenNames, extra: CHAT_INSERT_TOKENS, markUnknown: true }
  const others = [hasImage ? '画像 1枚' : '', attachmentLabel ?? ''].filter(Boolean).join(' ＋ ')
  const summary = firstLine || others ? <>{firstLine ? <>「<InsertText value={firstLine} tokenNames={tokenNames} extraTokens={CHAT_INSERT_TOKENS} markUnknown />」</> : null}{firstLine && others ? ' ＋ ' : ''}{others}</> : null
  const night = value ? isNightJst(value) : false
  const disabledReason = scheduledMessageInputReason(content, hasImage || Boolean(attachmentLabel), value)

  return (
    <Dialog
      open={open}
      onCancel={onClose}
      title="予約して送る"
      designWidth={420}
      busy={busy}
      error={error}
      confirmLabel={value ? `${shortJst(value)} に予約` : 'この日時で予約する'}
      confirmIcon={<Clock3 aria-hidden="true" />}
      onConfirm={onConfirm}
      confirmDisabled={Boolean(disabledReason) || targetStale}
      confirmDisabledReason={targetStale ? '対象が変わりました。閉じてから確認し直してください。' : disabledReason}
    >
      <OperationTargetSummary accounts={[{ id: accountId ?? '', name: accountId ? undefined : '不明' }]} externalTarget={{ label: '対象件数', name: '1人' }} />
      <div className={styles.schBox}>
        <p className={styles.schBoxLabel}>送るもの</p>
        <p className={styles.schBoxValue}>
          <FileText aria-hidden="true" className={styles.schBoxIcon} />
          <span className={styles.schBoxText} title={insertDisplayText(content, inserts)}>{summary ?? '書く欄に文を入れてください'}</span>
        </p>
      </div>
      <div className={styles.schGroup}>
        <p className={styles.schLabel}>すぐ選ぶ</p>
        <div className={styles.schChips}>
          {presets.map((preset) => (
            <FilterChip
              key={preset.key}
              selected={value === preset.value}
              onChange={() => onChange(preset.value)}
            >
              {preset.label}
            </FilterChip>
          ))}
        </div>
      </div>
      <div className={styles.schGroup}><Field note={<>日本時間です。相手が夜中（22時〜8時）になる日時は、選ぶと注意が出ます。</>} label="日時を決める" htmlFor="schedule-at"><SaveErrorField names={["value", "scheduledAt", "scheduled_at"]}><DateTimeField id="schedule-at" value={value} onChange={onChange} className={styles.schField} /></SaveErrorField>

{night ? (
          <p className={styles.schWarn} role="status">相手が夜中の時間です。送ってよいか確かめてください。</p>
        ) : null}</Field></div>
      {rowsFailed ? (
        <p className={styles.schError}>
          予約の一覧を読み込めませんでした。
          <button type="button" data-inbox-v6="scheduled-retry" className={styles.schLink} onClick={onRetryRows}>もう一度読み込む</button>
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.schGroup}>
          <p className={styles.schLabel}>予約中（{rows.length}）</p>
          <ul className={styles.schRows}>
            {rows.map((row) => (
              <li key={row.id} data-inbox-v6="scheduled-row" className={styles.schRow}>
                <span className={styles.schRowAt}>{row.label}</span>
                <span className={styles.schRowText} title={insertDisplayText(row.content, inserts)}><InsertText value={row.content} tokenNames={tokenNames} extraTokens={CHAT_INSERT_TOKENS} markUnknown /></span>
                <DateTimeField
                  aria-label="予約時刻を変更（日本時間）"
                  defaultValue={row.defaultValue}
                  disabled={!row.editable || row.tooLate}
                  onChange={(next) => { if (next) onReschedule(row.id, next) }}
                  className={styles.schRowField}
                />
                {row.tooLate
                  ? <span className={styles.schRowText}>まもなく送ります。取り消せません</span>
                  : <button type="button" className={styles.schLink} disabled={!row.editable} onClick={() => onCancelRow(row.id)}>予約を取り消す</button>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  )
}
