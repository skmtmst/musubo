'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useContext, useEffect, useRef, useState } from 'react'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import type { MediaItem, MediaReplacementImpact } from '@line-crm/shared'
import { ApiError, api } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Select from '@/components/shared/select'
import Pagination from '@/components/shared/pagination'
import ListRange from '@/components/ui/list-range'
import ListState from '@/components/shared/list-state'
import { checkedAtText, referenceKindText, referenceNameText } from './media-delete-impact'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'
import { TextField as SharedTextField } from '@/components/shared/text-field'

export default function MediaReplacementDialog({
  source,
  accountId,
  onClose,
  onComplete,
}: {
  source: MediaItem | null
  accountId: string | null
  onClose: () => void
  onComplete: (message: string) => void
}) {
  const saveErrors = useSaveFormErrors()
  const requestRef = useRef(0)
  const candidateRequestRef = useRef(0)
  const [candidates, setCandidates] = useState<MediaItem[]>([])
  const [candidateTotal, setCandidateTotal] = useState(0)
  const [candidatePage, setCandidatePage] = useState(1)
  /** 候補の読み込み状態。読込中・0件・失敗を分けて出す（N-205）。 */
  const [candidatePhase, setCandidatePhase] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  /** 名前検索。確定した語だけをAPIへ送る（入力中の1文字ごとには呼ばない）。 */
  const [candidateQueryInput, setCandidateQueryInput] = useState('')
  const [candidateQuery, setCandidateQuery] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [impact, setImpact] = useState<MediaReplacementImpact | null>(null)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: source !== null && (Boolean(replacementId) || busy), busy: source !== null && busy, onDiscard: onClose })

  useEffect(() => {
    requestRef.current += 1
    candidateRequestRef.current += 1
    setReplacementId('')
    setImpact(null)
    setPhase('idle')
    setBusy(false)
    setError('')
    setCandidatePage(1)
    setCandidateQueryInput('')
    setCandidateQuery('')
  }, [source])

  useEffect(() => {
    if (!source || !accountId) { setCandidates([]); setCandidateTotal(0); setCandidatePhase('empty'); return }
    const request = ++candidateRequestRef.current
    const requestedAccount = accountId
    setCandidatePhase('loading')
    void api.media.list(requestedAccount, {
      kind: source.kind,
      excludeId: source.id,
      query: candidateQuery || undefined,
      limit: 50,
      offset: (candidatePage - 1) * 50,
    })
      .then((response) => {
        // アカウント切替・窓の開き直し・検索で古くなった応答は捨てる。
        if (candidateRequestRef.current !== request) return
        if (!response.success) {
          setCandidatePhase('error')
          return
        }
        // 別アカウントの候補は出さない（共有 lineAccountId=null は残す）。
        const scoped = response.data.items.filter(
          (item) => item.lineAccountId == null || item.lineAccountId === requestedAccount,
        )
        setCandidates(scoped)
        setCandidateTotal(response.data.total)
        setCandidatePhase(scoped.length === 0 ? 'empty' : 'ready')
      })
      .catch(() => { if (candidateRequestRef.current === request) setCandidatePhase('error') })
  }, [accountId, candidatePage, candidateQuery, source])

  async function selectReplacement(id: string) {
    setReplacementId(id)
    setImpact(null)
    setError('')
    if (!source || !accountId || !id) {
      setPhase('idle')
      return
    }
    const request = requestRef.current + 1
    requestRef.current = request
    setPhase('loading')
    try {
      const response = await api.media.replacementImpact(source.id, id, accountId)
      if (requestRef.current !== request) return
      if (!response.success) throw new Error(response.error)
      setImpact(response.data)
      setPhase('ready')
    } catch (caught) {
      if (requestRef.current !== request) return
      const fieldFailure = saveErrors.capture(caught)
      setPhase('error')
      { if (!fieldFailure)

      setError(describeApiFailure(caught, '読み込み')) }
    }
  }

  /**
   * 差し替えの実行。'all' は全使用先、'partial' は影響確認で
   * 「差し替えられます」と出た箇所だけ（#918）。
   * 部分実行は専用ボタンの文言で明示確認してから呼ばれる。
   */
  async function replace(mode: 'all' | 'partial') {
    if (!source || !accountId || !impact || busy) return
    if (mode === 'all' && !impact.canReplace) return
    if (mode === 'partial' && !impact.canPartiallyReplace) return
    setBusy(true)
    setError('')
    try {
      const response = await api.media.replaceUsages(source.id, accountId, {
        replacementMediaId: impact.replacement.id,
        expectedRevision: impact.revision,
        scope: mode === 'partial' ? 'replaceable' : 'all',
      })
      if (!response.success) throw new Error(response.error)
      const verification = response.data.verification === 'verified'
        ? '差し替え後の使用先も確認できました。'
        : '差し替えは完了しましたが、残りの使用先は確認中です。'
      const skipped = response.data.skippedUsageCount ?? 0
      const remaining = skipped > 0
        ? `差し替えられなかった${skipped}か所は、元のメディアを使い続けます。`
        : ''
      guard.disarm()
      onComplete(`${response.data.replacedUsageCount}か所を「${impact.replacement.filename}」へ差し替えました。${remaining}${verification}`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      const message = describeApiFailure(caught, '保存')
      { if (!fieldFailure)

      setError(message) }
      setBusy(false)
      if (caught instanceof ApiError && caught.status === 409 && caught.data) {
        setImpact(caught.data as MediaReplacementImpact)
        setPhase('ready')
      }
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={source !== null}
      title={source ? `「${source.filename}」の使用先を差し替える` : ''}
      description="元のメディアは消さず、使われている場所だけを既存の別メディアへ付け替えます。"
      busy={busy}
      error={error || undefined}
      onCancel={onClose}
      footer={(<DialogActions>
          {impact?.canPartiallyReplace && !impact.canReplace ? (<Button type="button" variant="primary" onClick={() => void replace('partial')} disabled={busy} busy={busy} busyLabel="差し替えています…">
              {`差し替え可能な${impact.replaceableCount}か所だけ差し替える`}
            </Button>) : (<Button type="button" variant="primary" onClick={() => void replace('all')} disabled={busy || !impact?.canReplace} disabledReason={candidatePhase === 'ready' && !replacementId ? '差し替え先を選んでください。' : undefined} busy={busy} busyLabel="差し替えています…">使用先を差し替える
            </Button>)}
        </DialogActions>)}
    >
      <div className="space-y-4">
        <div><Field label="差し替え先" required><form
            className="mb-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setCandidatePage(1)
              setCandidateQuery(candidateQueryInput.trim())
            }}
          >
            <SaveErrorField names={["candidateQueryInput","candidate_query_input"]}><SharedTextField
              type="text"
              aria-label="差し替え候補を名前で探す"
              placeholder="名前で探す"
              value={candidateQueryInput}
              onChange={(event) => setCandidateQueryInput(event.target.value)}
              className="border-hairline rounded-control bg-canvas text-ink focus:ring-accent w-full border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
            /></SaveErrorField>
            <Button type="submit">検索</Button>
          </form>
{candidatePhase === 'loading' ? (
            <ListState kind="loading" title="差し替え候補を読み込んでいます" />
          ) : candidatePhase === 'error' ? (
            <ListState
              kind="error"
              title="差し替え候補を読み込めませんでした"
              description="読み直してから、もう一度お試しください。"
            />
          ) : candidatePhase === 'empty' ? (
            <ListState
              kind="empty"
              title={
                candidateQuery
                  ? `「${candidateQuery}」に合う候補が見つかりませんでした`
                  : '同じ種類の別メディアがありません'
              }
              description={
                candidateQuery
                  ? '検索語を変えてください。'
                  : '先に差し替え先を登録してください。'
              }
            />
          ) : (
            <>
              <SaveErrorField names={["replacementId","replacement_id"]}><EntitySelect
                aria-label="差し替え先"
                value={replacementId}
                options={[{ value: '', label: '別のメディアを選択' }, ...candidates.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.filename }))]}
                onChange={(value) => void selectReplacement(value)}
              /></SaveErrorField>
              {candidateTotal > 50 ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-ink-faint">
                    <ListRange label="候補" total={candidateTotal} first={(candidatePage - 1) * 50 + 1} last={Math.min(candidatePage * 50, candidateTotal)} />
                    {candidateQuery ? `（「${candidateQuery}」で絞り込み中）` : ''}
                  </span>
                  <Pagination page={candidatePage} pageCount={Math.ceil(candidateTotal / 50)} onPageChange={setCandidatePage} />
                </div>
              ) : candidateQuery ? (
                <p className="text-ink-faint mt-2 text-xs">「{candidateQuery}」で絞り込み中（{formatNumber(candidateTotal)} 件）</p>
              ) : null}
            </>
          )}</Field></div>

        {phase === 'loading' ? (
          <p className="text-ink-faint text-xs">差し替わる場所を確認しています…</p>
        ) : phase === 'error' ? (
          <Notice tone="danger" >影響を確認できませんでした。読み直してから、もう一度お試しください。</Notice>
        ) : impact ? (
          <div className="space-y-3">
            <Notice tone={impact.canReplace ? 'success' : 'danger'}>
              {impact.canReplace
                ? `${impact.replaceableCount}か所すべてを差し替えられます。`
                : impact.canPartiallyReplace
                  ? `${impact.usageCount}か所のうち${impact.replaceableCount}か所を差し替えられます。残り${impact.blockedCount}か所は元のメディアを使い続けます。`
                  : 'この画面からは差し替えられる使用先がありません。'}
            </Notice>
            {impact.blockedCount > 0 ? (
              <p className="text-ink-faint text-xs">
                差し替えられない使用先：
                {Object.entries(impact.blockedByKind)
                  .map(([kind, count]) => `${referenceKindText(kind as Parameters<typeof referenceKindText>[0])}${formatNumber(count)} 件`)
                  .join('・')}
              </p>
            ) : null}
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {impact.references.map((reference, index) => (
                <li key={`${reference.kind}-${index}`} className="border-hairline rounded-control border p-3 text-xs">
                  <p className="text-ink font-semibold">{referenceKindText(reference.kind)}「{referenceNameText(reference)}」</p>
                  <p className={reference.replaceable ? 'text-success mt-1' : 'text-danger mt-1'}>
                    {reference.replaceable ? '差し替えられます' : reference.reason || 'この画面からは差し替えられません'}
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-ink-faint text-xs">{checkedAtText(impact.checkedAt)} 時点で確認</p>
          </div>
        ) : null}
      </div>
    </Dialog><OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider></SaveErrorScope>
  )
}
