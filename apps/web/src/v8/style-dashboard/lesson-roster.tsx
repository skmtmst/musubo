'use client'
import { CheckCheck, CreditCard, MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import Button from '@/components/shared/button'
import CloseButton from '@/components/shared/close-button'
import { RowMenu } from '@/components/shared/row-actions'
import StatusBadge from '@/components/shared/status-badge'
import type { StyleRoster } from './model'
import styles from './style-dashboard.module.css'
import { formatNumber } from '@/lib/format'

/*
 * 教室の「名簿のパネル」（k2MBw）。一覧で回を押すと右に開く。
 * 出席の印・この回の人に LINE・支払いのリンク（Stripe をつなぐまで押せない）・休講にする。
 */
export function LessonRoster({ roster, canWrite, onClose, onPay, onAttend, onAbsent, onLine, onCancelClass, onReportAbsence, absenceAllowed, absenceLockedReason }: {
  roster: StyleRoster
  canWrite: boolean
  onClose: () => void
  onPay: () => void
  onAttend: (bookingId: string | null) => void
  onAbsent: (bookingId: string) => void
  onReportAbsence?: (member: StyleRoster['members'][number]) => void
  absenceAllowed?: boolean
  absenceLockedReason?: string
  onLine: () => void
  onCancelClass: () => void
}) {
  const [all, setAll] = useState(false)
  const members = all ? roster.members : roster.members.slice(0, 7)
  const hidden = roster.members.length - members.length
  return (
    <section className={styles.roster} aria-label={`${roster.title}の名簿`}>
      <div className={styles.rosterHead}>
        <div className={styles.rosterTitle}>
          <span className={styles.cellSub}>{roster.head}</span>
          <h3>{roster.title}</h3>
        </div>
        <CloseButton size="standard" aria-label="名簿を閉じる" onClick={onClose} />
      </div>
      <div className={styles.rosterMeta}><StatusBadge tone={roster.pay.tone}>{roster.pay.label}</StatusBadge><span className={styles.cellMuted}>{roster.meta}</span></div>
      {canWrite ? (
        <div className={styles.rosterTools}>
          <Button size="compact" onClick={() => onAttend(null)}><CheckCheck size={16} aria-hidden="true" />全員出席</Button>
          <Button size="compact" onClick={onLine}><MessageCircle size={16} aria-hidden="true" />この回の人に LINE</Button>
          <span className={styles.grow} />
          <RowMenu appearance="box" size="row" label="この回の操作" items={[{ id: 'line', label: 'この回の人に LINE を送る', onSelect: onLine }, { id: 'cancel', label: '休講にする', tone: 'danger', onSelect: onCancelClass }]} />
        </div>
      ) : null}
      <div className={styles.rosterList}>
        {members.map((m) => (
          <div key={m.bookingId ?? m.name} className={styles.rosterRow}>
            <span className={styles.rosterName}><strong>{m.name}</strong><span className={styles.cellSub}>{m.sub}</span></span>
            <span className={styles.grow} />
            {m.pay.label === '—' ? <span className={styles.cellMuted}>—</span> : <StatusBadge tone={m.pay.tone}>{m.pay.label}</StatusBadge>}
            {onReportAbsence && m.canReportAbsence && m.bookingId && m.eventId && m.startsAt && Date.parse(m.startsAt) > Date.now() ? <Button size="compact"
              lockedReason={absenceLockedReason} disabled={!absenceAllowed} onClick={() => onReportAbsence(m)}>欠席</Button> : null}
            <span className={styles.rosterAttend}>
              {m.attend === 'done' ? <span className={styles.attendDone}>✓ 出席</span> : m.attend === 'absent' ? <span className={styles.cellMuted}>欠席</span> : m.attend === 'cancel' ? <span className={styles.cellMuted}>取消</span> : canWrite && m.attend === 'button' && m.bookingId ? (
                <span className={styles.actionPair}>
                  <Button size="compact" onClick={() => onAttend(m.bookingId!)}>出席</Button>
                  {(m.startsAt ? Date.parse(m.startsAt) <= Date.now() : roster.started) ? <Button size="compact" onClick={() => onAbsent(m.bookingId!)}>無断欠席</Button> : null}
                </span>
              ) : <span className={styles.cellMuted}>—</span>}
            </span>
          </div>
        ))}
      </div>
      {hidden > 0 ? <button type="button" className={styles.sideMoreButton} onClick={() => setAll(true)}>ほか {hidden}人を表示する<ArrowRight size={16} aria-hidden="true" /></button> : null}
      {canWrite ? (
        <div className={styles.rosterFoot}>
          <Button onClick={onPay}><CreditCard size={16} aria-hidden="true" />支払いのリンクを送る（{formatNumber(roster.payLinkCount)}人）</Button>
          <span className={styles.grow} />
          <Button variant="text" textTone="danger" onClick={onCancelClass}>休講にする</Button>
        </div>
      ) : null}
    </section>
  )
}
