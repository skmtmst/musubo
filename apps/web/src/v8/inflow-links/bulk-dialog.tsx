'use client'
import FolderSelect from '@/components/shared/folder-select'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { ApiError, api } from '@/lib/api'
import type { EntryRoute } from '@line-crm/shared'
import { formatNumber } from '@/lib/format'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

export type BulkRouteAction = 'pause' | 'resume' | 'move'

/**
 * 「まとめて操作」の窓（NEXT-21）。
 *
 * 対象（表のチェックで選んだ登録済み経路）→ できる操作 → 何件に効くか、
 * の順に見せてから実行する。実行は1件ずつ既存の更新口へ投げ、結果を
 * 成功・失敗に分けて出す。失敗分だけを残して閉じると、一覧では
 * 失敗分だけが選ばれた状態に戻る。
 *
 * ★V8 の一覧（src/v8/inflow-links/list.tsx）用の写し（元は
 * app/inflow-links/_components/bulk-routes-dialog.tsx。src/v8 からは import できないため）。
 * 違いは1つだけ：一括バーで押した操作（`initialAction`）を最初から選んだ状態で開く。
 */
export default function BulkRoutesDialog({
  targets,
  genreOptions,
  onApplied,
  onClose,
  scopeRef,
  initialAction = null,
}: {
  /** entry_routes に登録済みの経路だけが対象。 */
  targets: EntryRoute[]
  genreOptions: string[]
  /** 実行が1回でも終わったら呼ぶ。残った対象のIDを渡す。 */
  onApplied: (remainingIds: string[]) => void
  onClose: () => void
  scopeRef?: RefObject<{ generation: number }>
  /** 一括バーで押した操作。渡すとその操作を選んだ状態で開く。 */
  initialAction?: BulkRouteAction | null
}) {
  const saveErrors = useSaveFormErrors()
  const openedGeneration = useRef(scopeRef?.current.generation)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const current = () => active.current && (!scopeRef || scopeRef.current.generation === openedGeneration.current)
  // 失敗した分だけ残して試し直せるよう、対象は窓の中で持ち直す。
  const [remaining, setRemaining] = useState<EntryRoute[]>(targets)
  const [action, setAction] = useState<BulkRouteAction | null>(initialAction)
  const [genre, setGenre] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    succeeded: EntryRoute[]
    failed: Array<{ route: EntryRoute; error: string }>
  } | null>(null)

  const pauseTargets = remaining.filter((route) => route.isActive)
  const resumeTargets = remaining.filter((route) => !route.isActive)
  const moveTargets = remaining.filter((route) => (route.genre ?? '') !== genre)
  const affected = action === 'pause' ? pauseTargets
    : action === 'resume' ? resumeTargets
    : action === 'move' ? moveTargets
    : []

  const run = async () => {
    if (!current() || !action || busy || affected.length === 0) return
    setBusy(true)
    const succeeded: EntryRoute[] = []
    const failed: Array<{ route: EntryRoute; error: string }> = []
    for (const route of affected) {
      if (!current()) return
      try {
        const res = action === 'move'
          ? await api.entryRoutes.update(route.id, { genre: genre === '' ? null : genre })
          : await api.entryRoutes.update(route.id, { isActive: action === 'resume' })
        if (res.success) succeeded.push(route)
        else failed.push({ route, error: res.error || '更新できませんでした' })
      } catch (cause) {
        saveErrors.capture(cause)
        failed.push({
          route,
          error: cause instanceof ApiError && cause.status === 403
            ? permissionDeniedMessage('store')
            : '通信できませんでした',
        })
      }
    }
    if (!current()) return
    setResult({ succeeded, failed })
    setRemaining(failed.map((entry) => entry.route))
    setAction(null)
    setBusy(false)
    onApplied(failed.map((entry) => entry.route.id))
  }

  const close = () => {
    if (busy) return
    active.current = false
    onClose()
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open
      title="流入経路をまとめて操作"
      description="選んだ経路に同じ操作をまとめて行います。実行前に、実際に変わる件数を確認できます。"
      busy={busy}
      onCancel={close}
      footer={result ? undefined : (<DialogActions>
          <Button type="button" onClick={close} disabled={busy}>
            キャンセル
          </Button>
          {action && affected.length > 0 ? (<Button type="button" variant="primary" disabled={busy} onClick={() => { void run() }} busy={busy} busyLabel="実行中…">
              {`${formatNumber(affected.length)} 件に実行する`}
            </Button>) : null}
        </DialogActions>)}
    >
      <OperationTargetSummary accounts={[{ id: '', label: '受付先アカウント', name: '不明' }]} />
      <p className="text-body">受付先の全アカウントは確認できません。</p>
      {result ? (
        <div className="space-y-3">
          <p className="text-ink text-sm">
            {formatNumber(result.succeeded.length)} 件に反映しました。
          </p>
          {result.failed.length > 0 ? (
            <div className="space-y-2">
              <p className="text-danger text-sm font-semibold">
                {formatNumber(result.failed.length)} 件は実行できませんでした。
              </p>
              <ul className="divide-hairline divide-y rounded-control border border-hairline text-sm">
                {result.failed.map(({ route, error }) => (
                  <li key={route.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-ink min-w-0 truncate">{route.name}</span>
                    <span className="text-danger shrink-0 text-xs">{error}</span>
                  </li>
                ))}
              </ul>
              {result.failed.every((entry) => entry.error === 'この操作を行う権限がありません') ? (
                <p className="text-ink-faint text-xs leading-5">
                  すべて権限で止められました。統括または管理者に依頼してください。
                </p>
              ) : null}
              <p className="text-ink-faint text-xs leading-5">
                閉じると、実行できなかった分だけが選ばれた状態に戻ります。
              </p>
            </div>
          ) : null}
        </div>
      ) : remaining.length === 0 ? (
        <p className="text-ink-secondary text-sm leading-6">
          まとめて操作する流入経路が選ばれていません。
          一覧の左はしにあるチェックで対象を選んでから、もう一度開いてください。
          まとめて操作できるのは登録済みの経路だけです（「計測済」「未登録」の行は対象外）。
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-ink text-sm font-semibold">
              対象 {formatNumber(remaining.length)} 件
            </p>
            <p className="text-ink-faint mt-1 text-xs leading-5">
              {remaining.slice(0, 8).map((route) => route.name).join('、')}
              {remaining.length > 8 ? ` ほか${formatNumber((remaining.length - 8))} 件` : ''}
            </p>
          </div>
          <SaveErrorField names={["inflow-bulk-action","value","option.value","action"]}><RadioCardGroup legend="どの操作をしますか？">
            {([
              {
                value: 'pause' as const,
                label: 'まとめて停止する',
                note: `選んだ中の受付中 ${formatNumber(pauseTargets.length)} 件が対象です。`,
                count: pauseTargets.length,
              },
              {
                value: 'resume' as const,
                label: 'まとめて再開する',
                note: `選んだ中の停止中 ${formatNumber(resumeTargets.length)} 件が対象です。`,
                count: resumeTargets.length,
              },
              {
                value: 'move' as const,
                label: 'フォルダをまとめて移動する',
                note: `選んだ中の ${formatNumber(moveTargets.length)} 件が変わります。`,
                count: -1,
              },
            ]).map((option) => {
              const unavailable = option.count === 0
              return (
                <RadioCard
                  key={option.value}
                  name="inflow-bulk-action"
                  value={option.value}
                  checked={action === option.value}
                  disabled={unavailable}
                  disabledReason="今の選択には効きません"
                  onChange={() => setAction(option.value)}
                  title={option.label}
                  note={option.note}
                />
              )
            })}
          </RadioCardGroup></SaveErrorField>
          {action === 'move' ? (
            <SaveErrorField names={["genre"]}><FolderSelect
              aria-label="移動先のフォルダ"
              value={genre}
              size="full"
              onChange={setGenre}
              folders={genreOptions.map((name) => ({ value: name, label: name }))}
              className="mt-2"
            /></SaveErrorField>
          ) : null}
        </div>
      )}
    </Dialog></SaveErrorScope>
  )
}
