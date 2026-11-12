'use client'
import { formatYen as yen } from '@line-crm/shared';
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Steps } from '@/components/templates/steps'
import Checkbox from './checkbox'
import Dialog from './dialog'
import { Field, TextInput } from './form-controls'
import Radio from './radio'
import StatusBadge, { type StatusBadgeTone } from './status-badge'
import TestModeNote from './test-mode-note'
import styles from './booking-confirm-dialogs.module.css'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

/*
 * 予約・お金・連絡が絡む、戻せない操作の確かめの窓（・2026-10-16）。どの画面も同じ部品で出す。
 * - 予約を取り消す（★V8 h2lHCH）：お支払いの扱い・理由（必須）・LINE で知らせる（文の見本）
 * - 返金する（Y8MWGs・PpBzn・v6mT4f）：2 段。①金額（全額／一部）と理由（必須）②確かめ
 * - 休講にする（Md9O3）：人数・お金と回数券の扱い・理由（必須）・送る LINE
 * - 休みの重なる予約（s8BwT8）：休みを入れる窓の 2 段目。重なる予約・予約の扱い・送る LINE
 * 試験モードの間は、お金の数のそばに「試験モード」の印（TestModeNote）。
 */

export type Fact = { label: string; value: ReactNode }

function Facts({ facts, testMode, testText }: { facts: Fact[]; testMode?: boolean; testText: string }) {
  return (
    <div className={styles.facts}>
      <dl>{facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
      {testMode ? <TestModeNote>{testText}</TestModeNote> : null}
    </div>
  )
}

function Message({ text }: { text: string }) {
  return <p className={styles.message}>{text}</p>
}

export type CancelReservationInput = { refund: 'none' | 'full' | 'partial'; reason: string; notify: boolean }

export function CancelReservationDialog({ open, title, subtitle, facts, fullAmount, testMode, busy, error, messageFor, onClose, onConfirm, cancellationOnly = false, targetSummary }: {
  open: boolean
  title: string
  subtitle: string
  facts: Fact[]
  /** 返金できる額（円）。支払いが無ければ null で「お支払いの扱い」を出さない。 */
  fullAmount: number | null
  testMode?: boolean
  busy?: boolean
  error?: string
  cancellationOnly?: boolean
  targetSummary?: ReactNode
  messageFor: (input: CancelReservationInput) => string
  onClose: () => void
  onConfirm: (input: CancelReservationInput) => void
}) {
  const [refund, setRefund] = useState<CancelReservationInput['refund']>('full')
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(true)
  useEffect(() => { if (open) { setRefund(fullAmount ? 'full' : 'none'); setReason(''); setNotify(true) } }, [open, fullAmount])
  const input = cancellationOnly ? { refund: 'none' as const, reason, notify: false } : { refund, reason, notify }
  return (
    <Dialog contentLayout="form" open={open} title={title} description={subtitle} designWidth={480} tone="destructive" confirmation busy={busy} error={error}
      confirmLabel="予約を取り消す" cancelLabel="やめる" footerLead={cancellationOnly ? undefined : <span className={styles.lead}>取り消すと元に戻せません</span>}
      confirmDisabled={!reason.trim()} confirmDisabledReason="取り消す理由を入れてください" onCancel={onClose} onConfirm={() => onConfirm(input)}>
      <div className={styles.body}>
        {targetSummary}
        <Facts facts={facts} testMode={testMode} testText="本当の返金は起きません" />
        {!cancellationOnly && fullAmount ? (
          <Field label="お支払いの扱い" optional={false}>
            <div className={styles.choices} role="radiogroup" aria-label="お支払いの扱い">
              <Radio name="cancel-refund" checked={refund === 'none'} onChange={() => setRefund('none')}>決まりどおり返金しない</Radio>
              <Radio name="cancel-refund" checked={refund === 'full'} onChange={() => setRefund('full')}>{`全額を返金する（${yen(fullAmount)}）`}</Radio>
              <Radio name="cancel-refund" checked={refund === 'partial'} onChange={() => setRefund('partial')}>一部を返金する（次で金額を入れる）</Radio>
            </div>
          </Field>
        ) : null}
        <Field label="取り消す理由" required><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="お店の都合（食材が届かない）" /></Field>
        {cancellationOnly ? <><p className={styles.note}>このお客さまへの自動の連絡・返金は行われません。</p><p className={styles.note}>取り消すと元に戻せません。</p></> : <>
          <Checkbox checked={notify} onCheckedChange={setNotify}>LINE でお客さまに知らせる</Checkbox>
          {notify ? <Message text={messageFor(input)} /> : null}
        </>}
      </div>
    </Dialog>
  )
}

export type RefundInput = { amount: number; reason: string; notify: boolean }

export function RefundDialog({ open, subtitle, facts, paidAmount, testMode, busy, error, destination, actorLabel, messageFor, onClose, onConfirm, targetSummary }: {
  open: boolean
  subtitle: string
  facts: Fact[]
  paidAmount: number
  targetSummary?: ReactNode
  testMode?: boolean
  /** 手順 2 の「返金先」（例「カード（•••• 4242）」）。 */
  destination?: string
  /** 手順 2 の「記録」に残る名前（例「見本 太郎（オーナー）」）。 */
  actorLabel?: string
  /** 手順 2 に出す、お客さまに送る LINE の文（PpBzn・v6mT4f）。 */
  messageFor?: (input: RefundInput) => string
  busy?: boolean
  error?: string
  onClose: () => void
  onConfirm: (input: RefundInput) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [mode, setMode] = useState<'full' | 'partial'>('full')
  const [amountText, setAmountText] = useState('')
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(true)
  useEffect(() => { if (open) { setStep(1); setMode('full'); setAmountText(''); setReason(''); setNotify(true) } }, [open])
  const amount = mode === 'full' ? paidAmount : Number(amountText.replace(/[^0-9]/g, '')) || 0
  const amountOk = amount > 0 && amount <= paidAmount
  const steps = <Steps label="返金の手順" currentKey={String(step)} steps={[{ key: '1', label: '金額と理由', state: step > 1 ? 'done' : 'todo' }, { key: '2', label: '確かめ', state: 'todo' }]} />
  return (
    <Dialog contentLayout="form" open={open} title={step === 1 ? '返金する' : `${yen(amount)} を返金しますか？`} description={subtitle} designWidth={480} busy={busy} error={error} steps={steps} stepKey={step}
      footerLead={<span className={styles.lead}>手順 {step} / 2</span>}
      confirmLabel={step === 1 ? '次へ' : `${yen(amount)}を返金する`} confirmIcon={step === 1 ? <ArrowRight size={16} aria-hidden="true" /> : undefined}
      tone={step === 2 ? 'destructive' : 'default'} confirmation={step === 2} cancelLabel={step === 1 ? 'キャンセル' : '戻る'}
      confirmDisabled={!amountOk || !reason.trim()} confirmDisabledReason={!amountOk ? `返金する額を ${yen(paidAmount)} までで入れてください` : '返金の理由を入れてください'}
      onCancel={() => (step === 2 ? setStep(1) : onClose())} onConfirm={() => (step === 1 ? setStep(2) : onConfirm({ amount, reason, notify }))}>
      <div className={styles.body}>
        {targetSummary}
        {step === 1 ? <Facts facts={facts} testMode={testMode} testText="本当の返金は起きません" /> : null}
        {step === 1 ? (
          <>
            <Field label="返金する額" optional={false}>
              <div className={styles.inline} role="radiogroup" aria-label="返金する額">
                <Radio name="refund-mode" checked={mode === 'full'} onChange={() => setMode('full')}>{`全額（${yen(paidAmount)}）`}</Radio>
                <Radio name="refund-mode" checked={mode === 'partial'} onChange={() => setMode('partial')}>一部を返金する</Radio>
              </div>
              {mode === 'partial' ? <TextInput inputMode="numeric" aria-label="返金する金額" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="¥6,500" /> : null}
              {mode === 'partial' && amount > 0 ? <p className={styles.note}>{yen(paidAmount)} まで。残りの {yen(Math.max(0, paidAmount - amount))} は支払い済みのまま残ります。</p> : null}
            </Field>
            <Field label="返金の理由" required note="理由は記録に残ります（だれが・いつ・理由）。お客さまには出ません。"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="1名減った分（当日のお電話）" /></Field>
            <Checkbox checked={notify} onCheckedChange={setNotify}>LINE でお客さまに返金を知らせる</Checkbox>
          </>
        ) : (
          <div className={styles.confirm}>
            {/* 絵 v6mT4f：返金する額・返金先・返金のあと・理由・記録と試験モードの印、送る LINE の文、取り消せない案内。 */}
            <Facts testMode={testMode} testText="本当の返金は起きません" facts={[
              { label: '返金する額', value: `${yen(amount)}（${amount < paidAmount ? '一部' : '全額'}）` },
              ...(destination ? [{ label: '返金先', value: destination }] : []),
              { label: '返金のあと', value: amount < paidAmount ? `支払い済み ${yen(paidAmount - amount)} が残ります` : '返金済みになります' },
              { label: '理由', value: reason },
              ...(actorLabel ? [{ label: '記録', value: `${actorLabel} として残ります` }] : []),
            ]} />
            {notify && messageFor ? <Field label="お客さまに送る LINE" optional={false}><Message text={messageFor({ amount, reason, notify })} /></Field> : <p className={styles.note}>{notify ? 'LINE でお客さまに知らせます。' : 'LINE では知らせません。'}</p>}
              <Notice tone="info">
                返金は取り消せません。カードへの反映は 5〜10 日かかります。
              </Notice>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export type CancelClassInput = { refundPaid: boolean; restoreTickets: boolean; stopPaymentLinks: boolean; reason: string }

export function CancelClassDialog({ open, subtitle, facts, counts, testMode, busy, error, messageFor, onClose, onConfirm }: {
  open: boolean
  subtitle: string
  facts: Fact[]
  counts: { members: number; paid: number; paidAmount: number; tickets: number; unpaid: number }
  testMode?: boolean
  busy?: boolean
  error?: string
  messageFor: (input: CancelClassInput) => string
  onClose: () => void
  onConfirm: (input: CancelClassInput) => void
}) {
  const [refundPaid, setRefundPaid] = useState(true)
  const [restoreTickets, setRestoreTickets] = useState(true)
  const [stopPaymentLinks, setStopPaymentLinks] = useState(true)
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setRefundPaid(true); setRestoreTickets(true); setStopPaymentLinks(true); setReason('') } }, [open])
  const input = { refundPaid, restoreTickets, stopPaymentLinks, reason }
  return (
    <Dialog contentLayout="form" open={open} title="この回を休講にしますか？" description={subtitle} designWidth={480} tone="destructive" confirmation busy={busy} error={error}
      confirmLabel="休講にする" cancelLabel="やめる" footerLead={<span className={styles.lead}>{formatNumber(counts.members)}人に LINE を送ります</span>}
      confirmDisabled={!reason.trim()} confirmDisabledReason="休講の理由を入れてください" onCancel={onClose} onConfirm={() => onConfirm(input)}>
      <div className={styles.body}>
        <Facts facts={facts} testMode={testMode} testText="本当の返金は起きません" />
        {counts.paid || counts.tickets || counts.unpaid ? <Field label="お金と回数券の扱い" optional={false}>
          <div className={styles.choices}>
            {counts.paid ? <Checkbox checked={refundPaid} onCheckedChange={setRefundPaid}>{`支払い済みの ${counts.paid}人に全額を返金する（${yen(counts.paidAmount)}）`}</Checkbox> : null}
            {counts.tickets ? <Checkbox checked={restoreTickets} onCheckedChange={setRestoreTickets}>{`回数券の ${counts.tickets}人に 1回分を戻す`}</Checkbox> : null}
            {counts.unpaid ? <Checkbox checked={stopPaymentLinks} onCheckedChange={setStopPaymentLinks}>{`未払いの ${counts.unpaid}人の支払いのリンクを止める`}</Checkbox> : null}
          </div>
        </Field> : null}
        <Field label="休講の理由（お客さまに出ます）" required><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="講師の体調不良のため" /></Field>
        <Field label={`${formatNumber(counts.members)}人に送る LINE`} optional={false}><Message text={messageFor(input)} /></Field>
      </div>
    </Dialog>
  )
}

export type OverlapRow = { time: string; name: string; sub: string; pay?: { label: string; tone: StatusBadgeTone } | null }
/** 休みを入れる前に、重なる予約と連絡の扱いを確認する。 */
export function ClosureOverlapStep({ rows, mediaNote }: {
  rows: OverlapRow[]
  mediaNote?: string | null
}) {
  return (
    <div className={styles.body}>
      <div className={styles.overlap}>
        {rows.map((r) => (
          <div key={`${r.time}-${r.name}`} className={styles.overlapRow}>
            <strong>{r.time}</strong>
            <span className={styles.overlapName}><strong>{r.name}</strong><span>{r.sub}</span></span>
            {r.pay ? <StatusBadge tone={r.pay.tone}>{r.pay.label}</StatusBadge> : null}
          </div>
        ))}
      </div>
      <p>重なる予約は取り消しません。</p>
      <p>重なる予約への連絡は自動では送られません。</p>
      {mediaNote ? <Notice tone="info">
        {mediaNote}
      </Notice> : null}
    </div>
  )
}
