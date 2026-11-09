'use client'

import { useEffect, useState } from 'react'
import type { MusuboIndividualQuote } from '@line-crm/shared'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { PageHeading } from '@/components/templates/page-frame'
import styles from './individual-quote-editor.module.css'

interface Review {
  to: string; subject: string; html: string; sendClaimedAt: string | null
}

export default function QuoteDeliveryReview({ applicationId, quote }: {
  applicationId: string; quote: MusuboIndividualQuote
}) {
  const [review, setReview] = useState<Review | null>(null)
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resolved, setResolved] = useState<'sent' | 'superseded' | null>(null)

  useEffect(() => {
    let cancelled = false
    api.individualQuotes.operations.sendReview(applicationId, quote.quoteNumber)
      .then((result) => {
        if (cancelled) return
        if (!result.success) { setError(japaneseDetailOf(new Error(result.error)) || '送信内容を読み込めませんでした。'); return }
        setReview(result.data)
      }).catch(() => { if (!cancelled) setError('送信内容を読み込めませんでした。再読み込みしてください。') })
    return () => { cancelled = true }
  }, [applicationId, quote.quoteNumber])

  const resolve = async (outcome: 'delivered' | 'not_delivered') => {
    if (evidence.trim().length < 12) {
      setError('メールサービスの配信履歴で確認した内容を12文字以上で記録してください。')
      return
    }
    setBusy(true); setError('')
    try {
      const result = await api.individualQuotes.operations.resolveSend(applicationId, quote.quoteNumber,
        { outcome, evidence: evidence.trim() })
      if (!result.success) throw new Error(result.error)
      setResolved(result.data.status)
    } catch (cause) {
      setError(japaneseDetailOf(cause) || '確認結果を保存できませんでした。')
    } finally { setBusy(false) }
  }

  return <div className={styles.page}>
    <p className={styles.breadcrumb}>ホーム › 個別見積もり › 送信結果の確認</p>
    <PageHeading title="メールの送信結果を確認"
      subtitle="送信要求の結果が不明です。メールサービスの配信履歴で宛先と見積もり番号を照合してください。" />
    <div className={styles.target}><strong>{quote.companyName}</strong>
      <span>見積もり番号 {quote.quoteNumber}</span><span>宛先 {review?.to ?? '確認中'}</span></div>
    {resolved ? <section className={styles.card} role="status">
      <h2>{resolved === 'sent' ? '送信済みに確定しました' : '見積もりを取り下げました'}</h2>
      <p className={styles.small}>{resolved === 'sent'
        ? '確認した配信履歴を監査記録に残しました。お客様は期限内に見積もりへ同意できます。'
        : '同じメールは再送しません。必要な場合は新しい見積もり番号で再発行してください。'}</p>
    </section> : <div className={styles.reviewGrid}>
      <section className={styles.card}>
        <h2>送信したメール</h2>
        <dl className={styles.compact}>
          <div><dt>宛先</dt><dd>{review?.to ?? '読み込み中'}</dd></div>
          <div><dt>件名</dt><dd>{review?.subject ?? '読み込み中'}</dd></div>
          <div><dt>送信要求</dt><dd>{review?.sendClaimedAt ?? '確認中'}</dd></div>
        </dl>
        {review && <iframe className={styles.mailPreviewFrame} title="送信したメール"
          sandbox="" srcDoc={review.html} />}
      </section>
      <section className={styles.card}>
        <h2>配信履歴で確認すること</h2>
        <p className={styles.small}>宛先・見積もり番号・送信時刻を照合します。結果を確認するまで、同じメールは再送しません。</p>
        <Field label="照合記録" required note="配信履歴で確認した事実を12〜500文字で残してください。">
          <TextArea value={evidence}
            onChange={(event) => setEvidence(event.target.value)} maxLength={500}
            placeholder="例：メールサービスの配信履歴で宛先と送信時刻を確認しました" />
        </Field>
        <p className={styles.small}>配信を確認できた場合は送信済みに確定します。未送信を確認した場合は取り下げ、新しい見積もり番号で再発行します。</p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        <div className={styles.reviewActions}>
          <Button type="button" variant="secondary" disabled={busy || !review}
            onClick={() => void resolve('not_delivered')}>未送信を確認して取り下げる</Button>
          <Button type="button" variant="primary" disabled={busy || !review}
            onClick={() => void resolve('delivered')}>配信確認済みとして確定</Button>
        </div>
      </section>
    </div>}
  </div>
}
