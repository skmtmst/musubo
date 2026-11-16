'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import AnalyticsV8, { type AnalyticsSlotsV8 } from '@/v8/analytics/analytics'
import FunnelFormV8 from '@/v8/analytics/funnel-form'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { Bookmark } from 'lucide-react'
import { TextField as SharedTextField } from '@/components/shared/text-field'
import TextLink from '@/components/shared/text-link'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'


export default function AnalyticsPage() {
  return <AnalyticsV8 slots={ANALYTICS_V8_SLOTS} />
}

/*
 * 分析は現役のV8（src/v8/analytics）に固定。ファネルの作る・編集フォームと
 * 結果の保存欄は今の部品を渡す（src/v8 から @/app を読めないため）。
 */
/* 新しい分析（V8）へ渡す今の部品：ファネルの作る・編集フォームと、結果の保存欄。 */
// 段に置ける種類の選択肢。正本は packages/db/src/analytics-funnels.ts の
// V6_FUNNEL_STEP_KINDS（この並びと同じ種類・同じ順を保つ。funnel-form-react.test.tsx が照合する）。
// 「段の作り方」の案内もこの一覧から作るので、選べる種類と説明がずれない。
const FUNNEL_STEP_KIND_OPTIONS = [
  { key: 'friend_add', label: '友だち追加', hint: '' },
  { key: 'tag', label: 'タグが付いた', hint: 'タグのID' },
  { key: 'field', label: '情報欄に値が入った', hint: '項目のID（値は問いません）' },
  { key: 'form', label: 'フォームに答えた', hint: 'フォームのID' },
  { key: 'site_event', label: 'サイトのページを見た', hint: 'パスのまとまり（例: thanks）' },
  { key: 'purchase', label: '購入が確定した', hint: '' },
  { key: 'link_click', label: 'リンクを踏んだ', hint: '計測リンクのID' },
  { key: 'conversion', label: '成果が記録された', hint: '成果地点のID' },
  { key: 'message', label: 'メッセージを受信した', hint: '' },
  { key: 'booking', label: '予約が確定した', hint: '' },
  { key: 'automation', label: 'オートメーションが動いた', hint: 'オートメーションのID' },
]

const ANALYTICS_V8_SLOTS: AnalyticsSlotsV8 = {
  // ★V8 のファネルを作る・直すは src/v8 の窓（板 ）。
  renderFunnelForm: ({ accountId, edit, presetConversion, onCancel, onCreated }) => <FunnelFormV8 accountId={accountId} edit={edit} presetConversion={presetConversion} onCancel={onCancel} onCreated={onCreated} />,
  renderSave: ({ accountId, sourceKind, sourceResultId, defaultName }) => <SaveAnalysisAction accountId={accountId} sourceKind={sourceKind} sourceResultId={sourceResultId} defaultName={defaultName} compact={sourceKind === 'cross'} />,
  funnelStepKindsLabel: FUNNEL_STEP_KIND_OPTIONS.map((item) => item.label).join('・'),
}

function SaveAnalysisAction({
  accountId,
  sourceKind,
  sourceResultId,
  defaultName,
  compact = false,
}: {
  accountId: string
  sourceKind: 'cross' | 'funnel'
  sourceResultId: string
  defaultName: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultName)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const dirty = !saved && name !== defaultName
  const guard = useUnsavedGuard({ dirty: dirty || saving, busy: saving, onDiscard: () => { setName(defaultName); setOpen(false) } })
  const current = useRef({ saving, accountId, sourceResultId, target: guard.leaveTarget })
  current.current = { saving, accountId, sourceResultId, target: guard.leaveTarget }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { guard.cancelLeave() }, [accountId, sourceResultId, defaultName, guard.cancelLeave])
  const discardAndLeave = () => {
    const target = guard.leaveTarget
    if (!alive.current || current.current.saving || current.current.accountId !== accountId || current.current.sourceResultId !== sourceResultId || !target || current.current.target !== target) return
    current.current.target = null
    guard.disarm(); guard.confirmLeave()
  }

  useEffect(() => {
    setOpen(false)
    setName(defaultName)
    setSaved(false)
    setError('')
  }, [accountId, defaultName, sourceResultId])

  const save = async () => {
    if (!name.trim() || !sourceResultId) return
    setSaving(true)
    setError('')
    try {
      const response = await api.analytics.saved.create(accountId, {
        name: name.trim(),
        sourceKind,
        sourceResultId,
      })
      if (!response.success) throw new Error(response.error)
      setSaved(true)
      setOpen(false)
    } catch (caught) {
      setError(describeApiFailure(caught, '保存'))
    } finally {
      setSaving(false)
    }
  }

  if (saved) {
    return (
      <Notice
        tone="success"
        action={
          <TextLink inline href="/analytics?tab=saved">
            保存した分析を見る
          </TextLink>
        }
      >
        定義とこの時点の結果を保存しました
      </Notice>
    )
  }

  return (
    <div className={compact && !open ? undefined : 'space-y-2'}>
      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`saved-analysis-${sourceKind}`} className="sr-only">保存する分析名</label>
          <SharedTextField
            id={`saved-analysis-${sourceKind}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            className="border-hairline rounded-control min-w-64 flex-1 border px-3 py-2 text-sm"
            placeholder="保存する分析名"
          />
          <Button onClick={() => void save()} disabled={saving || !name.trim()} variant="primary" busy={saving} busyLabel="保存中">この名前で保存する
          </Button>
          <Button onClick={() => setOpen(false)} disabled={saving} variant="secondary">
            キャンセル
          </Button>
        </div>
      ) : (
        <Button onClick={() => setOpen(true)} variant="secondary">
          <Bookmark size={16} aria-hidden="true" />この分析を保存
        </Button>
      )}
      {error && <p className="text-danger text-xs">{error}</p>}
      {!compact && <p className="text-ink-faint text-xs">条件の定義と、いま表示している結果を別々に固定して残します。</p>}
      <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="保存する分析名" onConfirm={discardAndLeave} onCancel={guard.cancelLeave} busy={saving} />
    </div>
  )
}
