'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, type OpsApplication } from '@/lib/api'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { useOverlayFocus, useOverlayLayer } from '@/components/shared/overlay-utils'
import { PageFrame } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import { TextArea } from '@/components/shared/text-field'
import EntitySelect from '@/components/shared/entity-select'
import { Field } from '@/components/shared/form-controls'
import type { StoredMusuboPricingCondition } from '@/lib/api/features/pricing-conditions'
import styles from './application-detail.module.css'

const statusLabel: Record<OpsApplication['status'], string> = {
  pending: '未対応', contacted: '連絡中', approved: '承認済み',
  rejected: '見送り', activated: '利用開始済み',
}

const dateTime = (value: string) => new Date(value).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const shortDateTime = (value: string) => new Date(value).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function OpsApplicationDetail() {
  return <Suspense fallback={<PageFrame kind="detail" boardId="g6NuH" standalone><ListState kind="loading" title="申込を読み込んでいます" /></PageFrame>}><Detail /></Suspense>
}

function Detail() {
  const id = useSearchParams().get('id') ?? ''
  const router = useRouter()
  const access = useOpsReadOnlyState()
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const [application, setApplication] = useState<OpsApplication | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conditions, setConditions] = useState<StoredMusuboPricingCondition[]>([])
  const [selectedConditionId, setSelectedConditionId] = useState('normal')
  const [conditionsReady, setConditionsReady] = useState(false)

  const load = useCallback(async () => {
    if (!id) { setError('申込が指定されていません'); setLoading(false); return }
    try {
      const result = await api.ops.applications.get(id)
      if (!result.success) { setError(result.error || '申込を読み込めませんでした'); return }
      setApplication(result.data)
      setNote(result.data.contact_note || '')
      setError('')
    } catch (caught) { setError(japaneseDetailOf(caught) || '申込を読み込めませんでした') }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let disposed = false
    void api.pricingConditions.list().then((result) => {
      if (disposed) return
      if (!result.success) throw new Error('conditions_unavailable')
      const active = result.data.filter((condition) => condition.status === 'active')
      setConditions(active)
      setSelectedConditionId(active.find((condition) => condition.conditionKey === 'normal')?.id ?? active[0]?.id ?? '')
      setConditionsReady(true)
    }).catch(() => {
      if (!disposed) { setConditionsReady(false); setError('利用条件を読み込めませんでした。再読み込みしてから承認してください') }
    })
    return () => { disposed = true }
  }, [])

  const contact = async () => {
    if (!application || busy || !note.trim() || access !== 'writer') return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.ops.applications.contact(application.id, note.trim())
      if (!result.success) { setError(result.error || '保存できませんでした'); return }
      setApplication(result.data); setMessage('連絡内容を保存しました')
    } catch (caught) { setError(japaneseDetailOf(caught) || '保存できませんでした') }
    finally { setBusy(false) }
  }

  const approve = async () => {
    if (!application || busy || access !== 'writer' || !conditionsReady
      || !applicableConditions.some((condition) => condition.id === selectedConditionId)) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.ops.applications.approve(application.id, selectedConditionId)
      if (!result.success) { setError(result.error || '承認できませんでした'); return }
      setApplication(result.data.application)
      setConfirmOpen(false)
      setMessage(result.data.mailSent ? '承認し、招待メールを送りました' : '承認しました。招待メールの送信に失敗したため、再送してください')
    } catch (caught) { setError(japaneseDetailOf(caught) || '承認できませんでした') }
    finally { setBusy(false) }
  }

  const resend = async () => {
    if (!application || busy || access !== 'writer') return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api.ops.applications.resendInvite(application.id)
      if (!result.success) { setError(result.error || '再送できませんでした'); return }
      setApplication(result.data); setMessage('招待メールを再送しました')
    } catch (caught) { setError(japaneseDetailOf(caught) || '再送できませんでした') }
    finally { setBusy(false) }
  }

  const canEdit = !!application && ['pending', 'contacted'].includes(application.status)
  const canApprove = application?.status === 'contacted' && !!application.contact_note && conditionsReady
  const companyKey = (value: string) => value.normalize('NFKC').replace(/[\s\u3000]/g, '').toLowerCase()
  const todayJst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(new Date())
  const applicableConditions = conditions.filter((condition) =>
    (!condition.allowedCompanyName || companyKey(condition.allowedCompanyName) === companyKey(application?.company_name ?? ''))
    && (!condition.approvalUseUntil || condition.approvalUseUntil >= todayJst))
  const writer = access === 'writer'
  const unknown = access === 'unknown'

  return <PageFrame kind="detail" boardId="g6NuH" standalone>
    <article className={styles.panel}>
      {error ? <Notice tone="danger" message={error} /> : null}
      {message ? <Notice tone={message.includes('失敗') ? 'warn' : 'success'} message={message} /> : null}
      {loading ? <ListState kind="loading" title="申込を読み込んでいます" /> : !application ? <ListState kind="error" title="申込を表示できませんでした" description={error} onRetry={() => void load()} /> : <>
        <header className={styles.heading}>
          <div><h1>{application.company_name}</h1><p>受付日 {dateTime(application.created_at)}</p></div>
          <span className={styles.status} data-status={application.status}>{statusLabel[application.status]}</span>
        </header>
        <div className={styles.columns}>
          <section className={styles.details} aria-labelledby="application-details-heading">
            <h2 id="application-details-heading">申込内容</h2>
            <dl className={styles.fields}>
              <div><dt>会社名</dt><dd>{application.company_name}</dd></div>
              <div><dt>担当者名</dt><dd>{application.contact_name}</dd></div>
              <div><dt>メールアドレス</dt><dd>{application.email}</dd></div>
              <div><dt>電話番号</dt><dd>{application.phone}</dd></div>
              <div><dt>musuboを知ったきっかけ</dt><dd>{application.referral_source}</dd></div>
            </dl>
          </section>
          <section className={styles.progress} aria-labelledby="application-progress-heading">
            <h2 id="application-progress-heading">対応状況</h2>
            <ol className={styles.steps}>
              <li data-done><strong>申込受付</strong><small>{shortDateTime(application.created_at)}</small></li>
              <li data-done={application.contacted_at ? '' : undefined}><strong>担当者から連絡</strong><small>{application.contacted_at ? shortDateTime(application.contacted_at) : 'まだ記録がありません'}</small></li>
              <li data-done={application.approved_at ? '' : undefined}><strong>承認・招待</strong><small>{application.invite_sent_at ? `メール送信 ${shortDateTime(application.invite_sent_at)}` : application.approved_at ? '招待メールの送信待ち' : '承認後にメールを送信'}</small></li>
            </ol>
            <div className={styles.memo}>
              <label htmlFor="application-contact-note">担当者からの連絡メモ</label>
              <TextArea id="application-contact-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="電話・メールで確認した内容を記録" readOnly={!canEdit || !writer} />
              {canEdit ? <Button variant="secondary" fullWidth lockedReason={lock} disabled={!note.trim() || busy || unknown} busy={busy} busyLabel="保存しています…" onClick={() => void contact()}>連絡済みとして保存</Button> : null}
            </div>
          </section>
        </div>
        <div className={styles.actionBand}>
          <p>担当者から連絡し、内容を確認してから承認してください。<br />連絡済みを保存すると、承認して招待できます。</p>
          {application.status === 'approved' ? <Button variant="primary" className={styles.approve} lockedReason={lock} disabled={busy || unknown} onClick={() => void resend()}>{application.invite_sent_at ? '招待メールを再送' : '招待メールを送る'}</Button>
            : application.status === 'activated' ? <Button variant="primary" className={styles.approve} lockedReason={lock} disabled={busy || unknown}
              onClick={() => router.push(`/ops/applications/quote?id=${encodeURIComponent(application.id)}`)}>個別見積もりを作成・確認</Button>
              : <Button variant="primary" className={styles.approve} lockedReason={lock}
                disabled={!canApprove || applicableConditions.length === 0 || busy || unknown}
                onClick={() => {
                  if (!applicableConditions.some((condition) => condition.id === selectedConditionId)) {
                    setSelectedConditionId(applicableConditions[0]?.id ?? '')
                  }
                  setConfirmOpen(true)
                }}>承認して招待メールを送る</Button>}
        </div>
      </>}
    </article>
    <ApprovalConfirm open={confirmOpen} application={application} busy={busy}
      conditions={applicableConditions} selectedConditionId={selectedConditionId}
      onSelectCondition={setSelectedConditionId}
      onConfirm={() => void approve()} onCancel={() => setConfirmOpen(false)} />
  </PageFrame>
}

function ApprovalConfirm({ open, application, busy, conditions, selectedConditionId,
  onSelectCondition, onConfirm, onCancel }: {
  open: boolean; application: OpsApplication | null; busy: boolean;
  conditions: StoredMusuboPricingCondition[]; selectedConditionId: string;
  onSelectCondition: (id: string) => void; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useOverlayFocus<HTMLDivElement>(open, onCancel, busy)
  const layer = useOverlayLayer(open)
  if (!open || !application || typeof document === 'undefined') return null
  return createPortal(<div className={styles.overlay} data-design-node="SVAtm" style={{ zIndex: layer }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="approval-title" className={styles.modal} tabIndex={-1}>
      <div className={styles.modalBody}>
        <h2 id="approval-title">この申込を承認しますか？</h2>
        <p>承認すると、申込者に利用開始のご案内を送ります。初期設定が完了するまではログインできません。</p>
        <dl className={styles.confirmFields}>
          <div><dt>会社名</dt><dd>{application.company_name}</dd></div>
          <div><dt>招待メール送信先</dt><dd>{application.email}</dd></div>
        </dl>
        <div className={styles.conditionChoice}>
          <Field label="適用する利用条件" htmlFor="approval-pricing-condition" optional={false}>
          <EntitySelect id="approval-pricing-condition" aria-label="適用する利用条件" size="full" value={selectedConditionId}
            onChange={onSelectCondition} options={conditions.map((condition) => ({
              value: condition.id,
              label: `${condition.internalName}・${condition.trialPeriod.value}${condition.trialPeriod.unit === 'months' ? 'か月' : '日'}無料${condition.lineBasicDiscountPercent ? `・LINE基本料金${condition.lineBasicDiscountPercent}%オフ` : ''}`,
            }))} />
          </Field>
          <small>選んだ条件は承認時に固定されます。あとから条件を変更しても、この会社の料金は変わりません。</small>
          <a className={styles.conditionHelpLink} href="/ops/pricing-conditions">利用条件の設定を開く</a>
        </div>
        <p className={styles.confirmNote}>申込内容と連絡記録を確認してから進めてください。</p>
      </div>
      <div className={styles.modalFooter}>
        <button type="button" onClick={onCancel} disabled={busy}>キャンセル</button>
        <button type="button" onClick={onConfirm} disabled={busy || !conditions.some((item) => item.id === selectedConditionId)}>{busy ? '承認しています…' : '承認して招待を送る'}</button>
      </div>
    </div>
  </div>, document.body)
}
