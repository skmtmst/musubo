'use client'

import { useCallback, useEffect, useState } from 'react'
import type { MusuboConditionDefinition } from '@line-crm/shared'
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared'
import ListState from '@/components/shared/list-state'
import { PageFrame } from '@/components/templates/page-frame'
import { api } from '@/lib/api'
import type { StoredMusuboPricingCondition } from '@/lib/api/features/pricing-conditions'
import BillingConditionEditor from './billing-condition-editor'

const newCondition = (): MusuboConditionDefinition => ({
  id: 'new-condition', version: 1, internalName: '', status: 'inactive',
  trialPeriod: { unit: 'days', value: 30 }, lineBasicDiscountPercent: 0,
  discountEndsOn: null, approvalUseUntil: null, allowedCompanyName: null,
  schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
})

function latestVersions(conditions: StoredMusuboPricingCondition[]): StoredMusuboPricingCondition[] {
  const seen = new Set<string>()
  return conditions.filter((condition) => {
    if (seen.has(condition.conditionKey)) return false
    seen.add(condition.conditionKey)
    return true
  })
}

export default function PricingConditionManagement() {
  const [conditions, setConditions] = useState<MusuboConditionDefinition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [editorVersion, setEditorVersion] = useState(0)

  const refresh = useCallback(async (selectedId?: string) => {
    try {
      const result = await api.pricingConditions.list()
      if (!result.success) throw new Error(result.error)
      const latest = latestVersions(result.data)
      setConditions(selectedId ? [
        ...latest.filter((item) => item.id === selectedId),
        ...latest.filter((item) => item.id !== selectedId),
      ] : latest)
      setEditorVersion((value) => value + 1)
      setError(false)
    } catch { setError(true) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const save = async (definition: MusuboConditionDefinition) => {
    const result = definition.id === 'new-condition'
      ? await api.pricingConditions.create(definition)
      : await api.pricingConditions.revise(definition.id, definition)
    if (!result.success) throw new Error(result.error)
    await refresh(result.data.id)
  }

  return <PageFrame kind="detail" standalone>
    {loading ? <ListState kind="loading" title="利用条件を読み込んでいます" />
      : error ? <ListState kind="error" title="利用条件を表示できませんでした" onRetry={() => void refresh()} />
        : <BillingConditionEditor key={editorVersion} conditions={conditions}
          onSave={save}
          onCreate={() => {
            setConditions((current) => [newCondition(), ...current.filter((item) => item.id !== 'new-condition')])
            setEditorVersion((value) => value + 1)
          }} />}
  </PageFrame>
}
