'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useListNavigationRouter } from '@/components/shared/list-navigation'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import TargetMissing from '@/components/shared/target-missing'

/** 名前のLinkから既存の改訂用下書きを開く。再読み込みも同じ下書きになる。 */
export default function AutomationDefinitionEntry({ automationId }: { automationId: string }) {
  const { selectedAccountId } = useAccount()
  const canEdit = canManageRole(useStaffRole())
  const router = useListNavigationRouter()
  const saveErrors = useSaveFormErrors()
  const [error, setError] = useState<unknown>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!selectedAccountId || !canEdit) return
    let alive = true
    setError(null)
    void api.automations.createDraftFromAutomation(automationId).then(res => {
      if (!alive) return
      if (!res.success) throw new Error(res.error)
      if (typeof res.data?.id !== 'string' || !res.data.id.trim()) throw new Error('下書きの情報を確認できませんでした。')
      router.replace(`/automations/drafts?id=${encodeURIComponent(res.data.id)}`)
    }).catch(cause => { if (alive) { saveErrors.capture(cause); setError(cause) } })
    return () => { alive = false }
  }, [automationId, selectedAccountId, canEdit, retry, router])
  if (!canEdit) return <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="このルールを編集する権限がありません" description="一覧から動いた記録を確認できます。" backHref="/automations" backLabel="ルールの一覧へ戻る" /></SaveErrorScope>
  if (error) return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="ルールを読み込めませんでした" description="一覧へ戻るか、もう一度お試しください。" error={error} onRetry={() => setRetry(value => value + 1)} /></SaveErrorScope>
  return null
}
