'use client'

import { Suspense } from 'react'
import ListState from '@/components/shared/list-state'
import IndividualQuoteFlow from '@/v8/ops/individual-quote-flow'

export default function OpsIndividualQuotePage() {
  return <Suspense fallback={<ListState kind="loading" title="個別見積もりを読み込んでいます" />}>
    <IndividualQuoteFlow />
  </Suspense>
}
