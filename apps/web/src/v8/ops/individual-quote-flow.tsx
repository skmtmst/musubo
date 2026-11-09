'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE, type AppliedMusuboCondition,
  type MusuboIndividualQuote, type MusuboPriceSchedule,
} from '@line-crm/shared'
import ListState from '@/components/shared/list-state'
import { PageFrame } from '@/components/templates/page-frame'
import { api, type OpsApplication } from '@/lib/api'
import IndividualQuoteEditor, { type QuoteMailPreview } from './individual-quote-editor'
import QuoteDeliveryReview from './quote-delivery-review'

function initialQuote(application: OpsApplication): MusuboIndividualQuote {
  let condition: AppliedMusuboCondition | null = null
  try { condition = application.pricing_snapshot_json
    ? JSON.parse(application.pricing_snapshot_json) as AppliedMusuboCondition : null } catch { /* pre-migration application */ }
  const schedule: MusuboPriceSchedule = { ...(condition?.schedule ?? DEFAULT_MUSUBO_PRICE_SCHEDULE) }
  if (condition?.lineBasicDiscountPercent && condition.discountEndsOn === null) {
    const factor = 100 - condition.lineBasicDiscountPercent
    schedule.firstLineYen = Math.floor(schedule.firstLineYen * factor / 100)
    schedule.secondToFifthLineYen = Math.floor(schedule.secondToFifthLineYen * factor / 100)
    schedule.sixthToTenthLineYen = Math.floor(schedule.sixthToTenthLineYen * factor / 100)
  }
  const now = new Date()
  return {
    quoteNumber: '下書き', companyName: application.company_name,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    acceptedAt: null, supersededAt: null, interval: 'month',
    plannedLineCount: 0, plannedFriendCountExcludingBlocked: 0,
    plannedLinkedAccountsByLine: [],
    trialPeriod: condition?.trialPeriod ?? { unit: 'days', value: 30 },
    finalSchedule: schedule, finalAnnualLineChargeYen: null,
  }
}

function proposal(quote: MusuboIndividualQuote) {
  return {
    expiresAt: quote.expiresAt, interval: quote.interval,
    plannedLineCount: quote.plannedLineCount,
    plannedFriendCountExcludingBlocked: quote.plannedFriendCountExcludingBlocked,
    plannedLinkedAccountsByLine: quote.plannedLinkedAccountsByLine,
    trialPeriod: quote.trialPeriod, finalSchedule: quote.finalSchedule,
    finalAnnualLineChargeYen: quote.finalAnnualLineChargeYen,
  }
}

export default function IndividualQuoteFlow() {
  const applicationId = useSearchParams().get('id') ?? ''
  const [application, setApplication] = useState<OpsApplication | null>(null)
  const [quote, setQuote] = useState<MusuboIndividualQuote | null>(null)
  const [sendingQuote, setSendingQuote] = useState<MusuboIndividualQuote | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    if (!applicationId) { setError(true); setLoading(false); return }
    try {
      const [applicationResult, quotesResult] = await Promise.all([
        api.ops.applications.get(applicationId),
        api.individualQuotes.operations.list(applicationId),
      ])
      if (!applicationResult.success || !quotesResult.success) throw new Error('load_failed')
      setApplication(applicationResult.data)
      setSendingQuote(quotesResult.data.find((item) => item.status === 'sending')?.quote ?? null)
      const draft = quotesResult.data.find((item) => item.status === 'draft')
      setQuote(draft?.quote ?? initialQuote(applicationResult.data))
      setError(false)
    } catch { setError(true) }
    finally { setLoading(false) }
  }, [applicationId])

  useEffect(() => { void load() }, [load])

  const saveDraft = async (editing: MusuboIndividualQuote): Promise<MusuboIndividualQuote> => {
    const result = editing.quoteNumber === '下書き'
      ? await api.individualQuotes.operations.create(applicationId, proposal(editing))
      : await api.individualQuotes.operations.update(applicationId, editing.quoteNumber, proposal(editing))
    if (!result.success) throw new Error(result.error)
    return result.data.quote
  }

  const loadMailPreview = async (saved: MusuboIndividualQuote): Promise<QuoteMailPreview> => {
    const result = await api.individualQuotes.operations.mailPreview(applicationId, saved.quoteNumber)
    if (!result.success) throw new Error(result.error)
    return result.data
  }

  const send = async (saved: MusuboIndividualQuote, preview?: QuoteMailPreview) => {
    if (!preview) throw new Error('mail_preview_required')
    const result = await api.individualQuotes.operations.send(applicationId, saved.quoteNumber, preview.previewHash)
    if (!result.success) throw new Error(result.error)
  }

  return <PageFrame kind="detail" standalone>
    {loading ? <ListState kind="loading" title="個別見積もりを読み込んでいます" />
      : error || !application || !quote ? <ListState kind="error" title="個別見積もりを表示できませんでした" onRetry={() => void load()} />
        : sendingQuote ? <QuoteDeliveryReview applicationId={applicationId} quote={sendingQuote} />
        : <IndividualQuoteEditor key={quote.quoteNumber} initialQuote={quote}
          recipientEmail={application.email} onSaveDraft={saveDraft}
          onLoadMailPreview={loadMailPreview} onSend={send} />}
  </PageFrame>
}
