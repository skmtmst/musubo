'use client'

import Button from '@/components/shared/button'
import { TextArea, TextField } from '@/components/shared/text-field'
import { useState } from 'react'
import Link from 'next/link'
import { ListPage } from '@/components/templates'
import { PageContent } from '@/components/templates/page-frame'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api } from '@/lib/api'
import type { PricingSelection } from './pricing'
import styles from './individual-quote-inquiry.module.css'

interface Props {
  selection: PricingSelection
  onBack?: () => void
  onSubmitted?: (ticketId: string) => void
  /** Allows the onboarding shell to keep submission and navigation in one place. */
  submit?: (subject: string, body: string) => Promise<string>
}

const countLabel = (value: number) => value > 10 ? '11個以上' : `${value}個`
const numberLabel = (value: number | null) => value === null ? '未入力' : `${new Intl.NumberFormat('ja-JP').format(value)}人`

export function individualQuoteInquiryBody(selection: PricingSelection, exactLineCount: string, notes: string): string {
  const linked = selection.lineCount === 1
  return [
    '個別見積もりのご相談',
    `連携予定のLINE公式アカウント: ${countLabel(selection.lineCount)}`,
    !linked && exactLineCount.trim() ? `具体的な予定数: ${exactLineCount.trim()}個` : null,
    `既存のLINEアカウントの友だち合計（ブロック除く）: ${numberLabel(selection.friendCountExcludingBlocked)}`,
    linked ? `Googleマイビジネスの連携予定: ${countLabel(selection.googleBusinessCount)}` : null,
    linked ? `Instagramアカウントの連携予定: ${countLabel(selection.instagramCount)}` : null,
    `希望するお支払いプラン: ${selection.interval === 'year' ? '年払い' : '月払い'}`,
    notes.trim() ? `連携方法・現在の運用:\n${notes.trim()}` : null,
  ].filter(Boolean).join('\n')
}

async function submitViaSupport(subject: string, body: string): Promise<string> {
  const result = await api.hqSupport.create({ kind: 'billing', purpose: 'individual_quote', subject, body })
  if (!result.success) throw new Error(result.error)
  return result.data.id
}

export default function IndividualQuoteInquiry({ selection, onBack, onSubmitted, submit = submitViaSupport }: Props) {
  usePageTitle('お見積もりのお問い合わせ')
  usePageCrumbs([{ label: 'ホーム', href: '/hq' }, { label: '利用開始の準備', href: '/hq/onboarding' }])
  const [exactLineCount, setExactLineCount] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ticketId, setTicketId] = useState('')
  const linked = selection.lineCount === 1
  const exactCountValid = exactLineCount === '' || (/^\d+$/.test(exactLineCount)
    && Number.isSafeInteger(Number(exactLineCount)) && Number(exactLineCount) >= 11)
  const body = individualQuoteInquiryBody(selection, exactLineCount, notes)
  const canSubmit = exactCountValid && body.length <= 4000 && !busy

  const send = async () => {
    if (!canSubmit || ticketId) return
    setBusy(true)
    setError('')
    try {
      const id = await submit('個別見積もりのお問い合わせ', body)
      setTicketId(id)
      onSubmitted?.(id)
    } catch {
      setError('お問い合わせを送信できませんでした。通信状態を確認して、もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  return <ListPage heightMode="viewport" title="お見積もりのお問い合わせ" help="ご利用予定を送信すると、担当者から個別料金をご案内します。">
    <PageContent>
      {ticketId ? <section className={styles.receipt} aria-labelledby="receipt-heading">
        <span className={styles.receiptIcon} aria-hidden="true">✓</span>
        <div>
          <h2 id="receipt-heading">お問い合わせを受け付けました</h2>
          <p>担当者がご利用予定を確認し、料金と利用開始の手順をご案内します。受付内容はお問い合わせから確認できます。</p>
          <p>料金への同意後にカード登録へ進みます。この時点では請求は始まりません。</p>
          <Link className={styles.ticketLink} href={`/hq/support/detail?id=${encodeURIComponent(ticketId)}`}>お問い合わせ内容を確認する</Link>
        </div>
      </section> : <>
        <p className={styles.lead}>{linked
          ? 'GoogleマイビジネスまたはInstagramを11個以上連携する場合は、利用予定を送信して個別料金をご確認ください。'
          : 'ご利用予定を送信すると、担当者から個別料金をご案内します。'}</p>
        <ol className={styles.steps} aria-label="お見積もりの手順">
          <li><span aria-hidden="true">✓</span>ご利用予定を確認</li>
          <li className={styles.current}><span>2</span>お問い合わせ</li>
          <li><span>3</span>料金をご案内</li>
        </ol>
        <div className={styles.columns}>
          <section className={styles.card} aria-labelledby="inquiry-heading">
            <h2 id="inquiry-heading">お問い合わせ内容</h2>
            <p className={styles.muted}>予定が決まっていない項目は空欄のままご相談いただけます。</p>
            <div className={styles.fields}>
              <div className={styles.field}><span>連携するLINEアカウント数</span><div className={styles.readonly}>{countLabel(selection.lineCount)}</div></div>
              {!linked && <label className={styles.field} htmlFor="exact-line-count"><span>具体的な予定数（任意）</span>
                <TextField id="exact-line-count" inputMode="numeric" value={exactLineCount} placeholder="例：12個"
                  aria-invalid={!exactCountValid} onChange={(event) => setExactLineCount(event.target.value)} />
                {!exactCountValid && <small className={styles.error}>11以上の整数で入力してください。</small>}
              </label>}
              <div className={styles.field}><span>既存のLINEアカウントの合計（ブロック除く）</span>
                <div className={styles.readonly}>{numberLabel(selection.friendCountExcludingBlocked)}</div></div>
              {linked && <div className={styles.linkedGrid}>
                <div className={styles.field}><span>Googleマイビジネスの連携予定数</span><div className={styles.readonly}>{countLabel(selection.googleBusinessCount)}</div></div>
                <div className={styles.field}><span>Instagramアカウントの連携予定数</span><div className={styles.readonly}>{countLabel(selection.instagramCount)}</div></div>
              </div>}
              <label className={styles.field} htmlFor="inquiry-notes"><span>{linked ? '連携方法・現在の運用' : 'Googleマイビジネス・Instagramの連携予定'}（任意）</span>
                <TextArea id="inquiry-notes" rows={4} maxLength={3500} value={notes}
                  placeholder={linked ? '例：Googleマイビジネス11個とInstagram1個を、このLINEに連携予定' : '例：LINEを12個、Googleマイビジネス12個とInstagram1個を連携予定'}
                  onChange={(event) => setNotes(event.target.value)} /></label>
            </div>
            <p className={styles.inputNote}>お見積もり前にカード情報を入力する必要はありません。</p>
          </section>
          <section className={styles.card} aria-labelledby="after-heading">
            <span className={styles.badge}>個別見積もり</span>
            <h2 id="after-heading">送信後のご案内</h2>
            <p className={styles.muted}>担当者が利用規模を確認し、料金と利用開始の手順をメールでご案内します。</p>
            <h3>お問い合わせに含まれる内容</h3>
            <dl className={styles.summary}>
              <div><dt>LINEアカウント数</dt><dd>{countLabel(selection.lineCount)}</dd></div>
              <div><dt>現在の友だち数</dt><dd>{numberLabel(selection.friendCountExcludingBlocked)}</dd></div>
              {linked ? <>
                <div><dt>Googleマイビジネス</dt><dd>{countLabel(selection.googleBusinessCount)}</dd></div>
                <div><dt>Instagram</dt><dd>{countLabel(selection.instagramCount)}</dd></div>
              </> : <div><dt>連携先の予定</dt><dd>{notes.trim() ? '入力内容を共有' : '未入力'}</dd></div>}
            </dl>
            <div className={styles.assurance}><strong>この時点で請求は始まりません</strong>
              <p>料金のご案内後、内容に同意してからカード登録とLINE接続へ進みます。</p></div>
          </section>
        </div>
        <div className={styles.footer}>
          <div>{onBack && <button type="button" className={styles.back} onClick={onBack}>ご利用予定を修正</button>}
            <p>送信後、登録メールアドレスへ受付のお知らせを送ります。</p></div>
          <Button type="button" className={styles.primary} busy={busy} busyLabel="送信中…" disabled={!canSubmit} onClick={() => void send()}>
            この内容で問い合わせる</Button>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </>}
    </PageContent>
  </ListPage>
}
