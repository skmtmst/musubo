import { useEffect, useState } from 'react'
import type { CommonVar } from '@line-crm/shared'
import { CardActionRow } from '@/components/shared/card'
import Button from '@/components/shared/button'
import { EntityPickerDialog } from '@/components/shared/entity-picker'
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import { api } from '@/lib/api'

/** 未指定の入口から、その店舗の編集対象を選ぶ。消失した対象には使わない。 */
export default function ChooseCommonVarTarget({ accountId, onSelect }: { accountId: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<{ accountId: string; items: CommonVar[] | null; failed: boolean } | null>(null)
  useEffect(() => {
    if (!open || !accountId) return
    let active = true
    setSnapshot(null)
    void api.commonVars.list(accountId).then(response => {
      if (!response.success) throw new Error('list failed')
      if (active) setSnapshot({ accountId, items: response.data, failed: false })
    }).catch(() => { if (active) setSnapshot({ accountId, items: null, failed: true }) })
    return () => { active = false }
  }, [open, accountId, attempt])
  const current = snapshot?.accountId === accountId ? snapshot : null
  return <>
    <TargetMissing kind="unspecified" title="編集する共通情報が指定されていません"
      description="この画面で編集する共通情報を選ぶか、一覧から選び直してください。"
      action={<CardActionRow><Button variant="secondary" disabled={!accountId} disabledReason={!accountId ? 'LINEアカウントを選んでください' : undefined} onClick={() => setOpen(true)}>編集する共通情報を選択する</Button><Button variant="secondary" href="/contents/vars">共通情報一覧へ戻る</Button></CardActionRow>} />
    {open ? <EntityPickerDialog title="編集する共通情報を選ぶ" items={(current?.items ?? []).map(item => ({ id: item.id, name: item.name }))}
      state={!accountId ? <ListState kind="empty" title="LINEアカウントを選んでください" /> : current?.failed ? <ListState kind="error" title="共通情報を読み込めませんでした" onRetry={() => setAttempt(value => value + 1)} /> : !current?.items ? <ListState kind="loading" /> : undefined}
      confirmLabel="編集する" confirmDisabled={!accountId || !current?.items || current.failed}
      onCancel={() => setOpen(false)} onConfirm={id => { if (current?.items?.some(item => item.id === id)) onSelect(id) }} /> : null}
  </>
}
