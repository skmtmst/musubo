'use client'

import { SaveConflictBand } from '@/components/shared/save-conflict';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Plus, RefreshCw } from 'lucide-react';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import { DetailColumns } from '@/components/templates/detail-columns'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import { RowActions } from '@/components/shared/row-actions';
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field';
import { Field, FieldError } from '@/components/shared/form-controls';
import { useFieldValidation } from '@/lib/use-field-validation';
import { describeApiFailure } from '@/components/shared/api-error-message';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { nenRanksApi, type NenRankSettingsData } from '@/lib/nen-ranks-api';
import { RULE_LABELS, parsePercent, parseYen, shortDateTime, shortTime, yen, type LoadStatus, type SavedHandler } from './parts';
import styles from './members.module.css'
import { emptyValue } from '@/components/shared/empty-value';
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import Notice from '@/components/shared/notice'

type RankDraft = { id: string | null; name: string; threshold: string; rate: string; tagId: string | null; tagName: string | null; memberCount: number }

const MAX_RANKS = 8

/** 入力欄に見せる形（絵どおり「¥200,000〜」「3%」）。保存の前に数へ戻す。 */
const thresholdText = (value: number) => `${yen(value)}〜`
const rateText = (value: number) => `${value}%`

const fromSettings = (next: NenRankSettingsData): RankDraft[] =>
  next.ranks.map((rank) => ({
    id: rank.id,
    name: rank.name,
    threshold: thresholdText(rank.annualThresholdYen),
    rate: rateText(rank.mileRatePercent),
    tagId: rank.tagId,
    tagName: rank.tagName,
    memberCount: rank.memberCount,
  }))

export default function RankSettingsV8({
  accountId,
  status,
  settings,
  onSaved,
  onRetry,
  readonly,
  onTopBand,
}: {
  accountId: string
  status: LoadStatus
  settings: NenRankSettingsData | null
  onSaved: SavedHandler
  onRetry: () => void
  readonly: boolean
  /** 競合の帯を外枠（タブの下）へ置く。null で外す。 */
  onTopBand: (band: ReactNode) => void
}) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const [drafts, setDrafts] = useState<RankDraft[]>([])
  const [asideExpanded, setAsideExpanded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 競合：読み込んだあとにほかの人が保存した形。latest はその時点で取り直した設定。 */
  const [conflict, setConflict] = useState<{ latest: NenRankSettingsData } | null>(null)
  const [comparing, setComparing] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<number | null>(null)
  const [replacement, setReplacement] = useState('')
  const [removePreview,setRemovePreview]=useState<{rankId:string;count:number;version:number;members:Array<{friendId:string;customerId:string|null}>}|null>(null)
  const [removePreviewError,setRemovePreviewError]=useState(false)
  const removeGeneration=useRef(0)
  const [draftAccountId, setDraftAccountId] = useState(accountId)
  const activeAccount = useRef({ id: accountId })
  if (activeAccount.current.id !== accountId) activeAccount.current = { id: accountId }
  const removeAccount = useRef<typeof activeAccount.current | null>(null)
  const removeContext = useRef<{ key: string; ticket: object; rowId: string; version: number } | null>(null)
  const currentRemoveKey = JSON.stringify([accountId, readonly, settings?.rules?.version, drafts])
  if (removeContext.current && removeContext.current.key !== currentRemoveKey) removeContext.current = null
  const removeTicket = removeContext.current?.ticket ?? null

  const fields = useFieldValidation(drafts.flatMap((row, index) => [
    ...(!row.name.trim() ? [{ id: `rank-name-${index}`, message: 'ランク名を入れるか、行を消してください。' }] : []),
    ...(!Number.isFinite(parseYen(row.threshold)) || parseYen(row.threshold) < 0
      ? [{ id: `rank-threshold-${index}`, message: 'しきい値は0以上の金額で入れてください。' }] : []),
    ...(!Number.isFinite(parsePercent(row.rate)) || parsePercent(row.rate) < 0
      ? [{ id: `rank-rate-${index}`, message: 'マイル還元は0以上の数（%）で入れてください。' }] : []),
  ]))

  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy })

  if (draftAccountId !== accountId) {
    const hadUnsaved = dirty
    setDraftAccountId(accountId)
    setDrafts([])
    setDirty(false)
    setBusy(false)
    setError('')
    setConflict(null)
    setComparing(false)
    setRemoveTarget(null)
    removeGeneration.current += 1
    setRemovePreview(null)
    setReplacement('')
    cancelLeave()
    setNotice(hadUnsaved ? 'LINEアカウントを切り替えたため、保存していない変更は破棄しました。' : '')
  }

  useEffect(() => {
    if (!settings || dirty) return
    setDrafts(fromSettings(settings))
  }, [settings, dirty])

  const update = (index: number, patch: Partial<RankDraft>) => {
    setDrafts((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    setDirty(true)
    setNotice('')
  }
  const add = () => {
    setDrafts((current) => {
      /* 足す行は、いちばん下（¥0 の固定）のすぐ上に入れる。 */
      const blank: RankDraft = { id: null, name: '', threshold: '', rate: '', tagId: null, tagName: null, memberCount: 0 }
      const baseIndex = current.findIndex((row, i) => i === current.length - 1 && parseYen(row.threshold) === 0)
      return baseIndex < 0 ? [...current, blank] : [...current.slice(0, baseIndex), blank, ...current.slice(baseIndex)]
    })
    setDirty(true)
  }
  const cancel = () => {
    fields.reset()
    setDirty(false)
    setError('')
    setConflict(null)
    if (settings) setDrafts(fromSettings(settings))
  }

  /** 競合を見つけたとき、最新を取り直して帯を出す。 */
  const showConflict = async () => {
    const target = activeAccount.current
    const res = await nenRanksApi.settings(accountId).catch(() => null)
    if (activeAccount.current !== target) return
    setConflict({ latest: res?.success ? res.data : (settings as NenRankSettingsData) })
  }

  /** 保存の前に最新を取り直し、読み込んだ版から進んでいたら競合の帯へ。 */
  const checkConflict = async (): Promise<boolean> => {
    const target = activeAccount.current
    if (!settings?.rules) return false
    const res = await nenRanksApi.settings(accountId)
    if (activeAccount.current !== target) return true
    if (!res.success) return false
    const latest = res.data
    if (latest.rules && latest.rules.version !== settings.rules.version) {
      setConflict({ latest })
      return true
    }
    return false
  }

  const save = async (force = false) => {
    const target = activeAccount.current
    if (busy || draftAccountId !== accountId) return
    const rows = drafts.map((row) => ({
      id: row.id,
      name: row.name.trim(),
      annualThresholdYen: parseYen(row.threshold),
      mileRatePercent: parsePercent(row.rate),
    }))
    setError('')
    if (!fields.submit()) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!force && await checkConflict()) return
      if (activeAccount.current !== target) return
      const res = await nenRanksApi.saveRanks(accountId, rows)
      if (activeAccount.current !== target) return
      if (!res.success) throw new Error(res.error)
      setDirty(false)
      setConflict(null)
      setComparing(false)
      onSaved(accountId, res.data)
      setNotice(res.data.sync?.status === 'synced'
        ? 'ランク設定を保存し、ECへ同期しました。タグも付け替えています。'
        : 'ランク設定を保存しました。ECへの同期は失敗したので、右の「もう一度同期」で送り直せます。')
    } catch (caught) {
      if (activeAccount.current !== target) return
      const fieldFailure = saveErrors.capture(caught)
      /* 保存の口が版の違いを 409 で返したときも、競合の帯へ。 */
      if (caught instanceof ApiError && caught.status === 409) {
        await showConflict()
      } else {
        { if (!fieldFailure)
        setError(describeApiFailure(caught, 'ランク設定の保存', {
          scope: 'store',
        })) }
      }
    } finally {
      if (activeAccount.current === target) setBusy(false)
    }
  }

  /** ごみ箱：保存前の行はその場で外す。保存済みの行は確かめてから消す。 */
  const askRemove = (index: number) => {
    const row = drafts[index]
    if (!row) return
    if (!row.id) {
      setDrafts((current) => current.filter((_, i) => i !== index))
      setDirty(true)
      return
    }
    /* 移す先は、ひとつ下のランクを先に選んでおく（いちばん多い選び方）。 */
    const below = drafts.slice(index + 1).find((candidate) => candidate.id)
      ?? [...drafts.slice(0, index)].reverse().find((candidate) => candidate.id)
    if (!settings?.rules || readonly) return
    removeAccount.current = activeAccount.current
    removeContext.current = { key: currentRemoveKey, ticket: {}, rowId: row.id, version: settings.rules.version }
    setReplacement(below?.id ?? '')
    setRemoveTarget(index)
    setRemovePreview(null)
    setRemovePreviewError(false)
    const scope=removeAccount.current,generation=++removeGeneration.current,rankId=row.id
    void nenRanksApi.rankDeletePreview(accountId,rankId).then(result=>{
      if(removeAccount.current===scope&&activeAccount.current===scope&&removeGeneration.current===generation&&result.success)setRemovePreview({rankId,...result.data})
      else if(removeAccount.current===scope&&removeGeneration.current===generation)setRemovePreviewError(true)
    }).catch(()=>{if(removeAccount.current===scope&&removeGeneration.current===generation)setRemovePreviewError(true)})
  }

  /** ランクの削除は版つきの DELETE（移す先を選んで会員を反映する）。 */
  const removeRank = async (ticket: object | null) => {
    const target = activeAccount.current
    const context = removeContext.current
    if (!ticket || !context || context.ticket !== ticket || removeTarget === null || removeAccount.current !== activeAccount.current || draftAccountId !== accountId || !settings?.rules || !removePreview || removePreview.version !== settings.rules.version || context.version !== removePreview.version) return
    const row = drafts[removeTarget]
    if (!row?.id || row.id !== context.rowId || row.id !== removePreview.rankId) return
    setBusy(true)
    setError('')
    try {
      const res = await nenRanksApi.deleteRank(accountId, row.id, {
        replacementRankId: removePreview.count > 0 ? replacement || null : null,
        expectedVersion: context.version,
        confirmedMembers: removePreview.members,
      })
      if (activeAccount.current !== target) return
      if (!res.success) throw new Error(res.error)
      removeContext.current = null
      setRemoveTarget(null)
      setReplacement('')
      setNotice(res.data.ecSync === 'synced' ? 'ランクを削除し、会員を移し先へ反映しました。' : `ランクを削除しました。${res.data.message ?? ''}`)
      onRetry()
    } catch (caught) {
      if (activeAccount.current !== target) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        setRemoveTarget(null)
        await showConflict()
      } else {
        { if (!fieldFailure)

        setError(describeApiFailure(caught, 'ランクの削除', {
          scope: 'store',
        })) }
      }
    } finally {
      if (activeAccount.current === target) setBusy(false)
    }
  }

  /** 「最新を読み込んで続ける」：新しい設定へ乗り換え、下書きは捨てる。 */
  const reloadLatest = () => {
    if (!conflict) return
    onSaved(accountId, conflict.latest)
    setConflict(null)
    setComparing(false)
    setDirty(false)
    setError('')
    setNotice('最新のランク設定を読み込みました。')
  }

  const resync = async () => {
    const target = activeAccount.current
    setBusy(true)
    setError('')
    try {
      const res = await nenRanksApi.resync(accountId)
      if (activeAccount.current !== target) return
      if (!res.success) throw new Error(res.error)
      onSaved(accountId, res.data)
      setNotice(res.data.sync?.status === 'synced' ? 'ECへ同期しました。' : `ECへの同期に失敗しました：${res.data.sync?.error ?? ''}`)
    } catch (caught) {
      if (activeAccount.current !== target) return
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(describeApiFailure(caught, 'ECへの同期', {
        scope: 'store',
      })) }
    } finally {
      if (activeAccount.current === target) setBusy(false)
    }
  }

  const initialize = async () => {
    const target = activeAccount.current
    if (readonly || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await nenRanksApi.initialize(accountId)
      if (activeAccount.current !== target) return
      if (!res.success) throw new Error(res.error)
      onSaved(accountId, res.data)
    } catch (caught) {
      if (activeAccount.current === target) setError(describeApiFailure(caught, '初期ランクの作成', { scope: 'store' }))
    } finally {
      if (activeAccount.current === target) setBusy(false)
    }
  }

  /* 競合の帯。保存した人の名前は API に無いので「ほかの人」と時刻で伝える。 */
  const conflictAt = conflict?.latest.rules ? shortTime(conflict.latest.rules.updatedAt) : null
  useEffect(() => {
    onTopBand(conflict ? (
      <div className={styles.conflictSlot} title={conflict?.latest.rules ? shortDateTime(conflict.latest.rules.updatedAt) : undefined}>
        <SaveConflictBand title={conflictAt ? `ほかの人が ${conflictAt} にランク設定を保存しました` : 'ほかの人がランク設定を保存しました'} description="このまま保存すると、ほかの人の変更が消えます" onCompare={() => setComparing(true)} onReload={reloadLatest} />
      </div>
    ) : null)
    // reloadLatest は conflict だけを読む。帯は conflict が変わったときだけ作り直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflict, conflictAt])
  useEffect(() => () => onTopBand(null), [onTopBand])

  if (status === 'loading' && !settings) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="ランク設定を読み込んでいます" /></SaveErrorScope>
  if (status === 'forbidden') return <SaveErrorScope errors={saveErrors}><ListState kind="forbidden" /></SaveErrorScope>
  if (status === 'error') return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="ランク設定を読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={onRetry} /></SaveErrorScope>
  if (!settings) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="ランク設定を読み込んでいます" /></SaveErrorScope>

  if (settings.ranks.length === 0) return <SaveErrorScope errors={saveErrors}>
    {error ? <Notice tone="danger">{error}</Notice> : null}
    <ListState kind="empty" title="ランクは未設定です" description="初期ランクを作成してから、内容を変更できます。" action={
      <Button variant="primary" onClick={() => void initialize()} busy={busy} busyLabel="作成中…" lockedReason={readonly ? '閲覧のみのため、管理者に頼んでください。' : undefined}>初期ランクを作る</Button>
    } />
  </SaveErrorScope>

  const missingTags = settings.ranks.some((rank) => !rank.tagName)
  const rules = settings.rules
  const removeRow = removeTarget !== null ? drafts[removeTarget] : null
  const removeCandidates = removeRow ? drafts.filter((row) => row.id && row.id !== removeRow.id) : []
  const removeName = removeRow?.name.trim() || `ランク ${(removeTarget ?? 0) + 1}`
  const moving = removePreview?.count ?? 0

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.rankBody}>
      {missingTags ? <Notice tone="warn">ランクのタグが見つかりません。ランク設定を保存すると作り直します。</Notice> : null}
      {notice || error ? (
        <div className={styles.messages}>
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {error ? <Notice tone="danger" >{error}</Notice> : null}
        </div>
      ) : null}

      <DetailColumns presentation="notification" asideLabel="ECとの同期" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<Card layout="vertical" padding="spacious" surface="standard" spacing="normal" aria-labelledby="nen-rank-sync">
          <div className={styles.cardHead}>
            <h2 id="nen-rank-sync" className={styles.cardTitle}>ECとの同期</h2>
            <p className={styles.cardDesc}>保存すると、ランクをネットショップへ送り、タグも付け替えます。送れなかったときは、理由がここに出ます</p>
          </div>
          <div className={styles.syncRow}>
            {rules?.syncStatus === 'synced'
              ? <StatusBadge tone="success" size="compact">同期済み</StatusBadge>
              : rules?.syncStatus === 'failed'
                ? <StatusBadge tone="danger" size="compact">失敗</StatusBadge>
                : <StatusBadge tone="warning" size="compact">未同期</StatusBadge>}
            <span className={styles.syncText}>
              {rules?.syncStatus === 'synced' && rules.syncedAt ? `最後に送った日時 ${shortDateTime(rules.syncedAt)}` : rules?.syncStatus === 'failed' ? rules.syncError ?? '理由は記録されていません' : 'まだECへ送っていません'}
            </span>
          </div>
          {readonly ? null : (
            <div className={styles.syncAction}>
              <Button variant="secondary" onClick={() => resync()} disabled={busy || dirty} busy={Boolean(busy)} busyLabel="処理中…">
                <RefreshCw size={16} aria-hidden="true" />もう一度同期
              </Button>
            </div>
          )}
        </Card>}>
        <div className={styles.rankMain}>
          <Card layout="vertical" padding="spacious" surface="standard" spacing="normal" aria-labelledby="nen-rank-rules">
            <div className={styles.cardHead}>
              <h2 id="nen-rank-rules" className={styles.cardTitle}>ランクの決まり</h2>
              <p className={styles.cardDesc}>通年の購入額でランクが決まります</p>
            </div>
            <div className={styles.ruleRow}>
              <RuleBox label="通年の区切り" value={RULE_LABELS.yearStartMonth(rules?.yearStartMonth ?? 1)} />
              <RuleBox label="集計に含める注文" value={RULE_LABELS.countOrders} />
            </div>
            <div className={styles.ruleRow}>
              <RuleBox label="上がったとき" value={RULE_LABELS.applyOnReach} />
              <RuleBox label="維持する期間" value={RULE_LABELS.keepUntil} />
            </div>
          </Card>

          <Card layout="vertical" padding="spacious" surface="standard" spacing="normal" aria-labelledby="nen-rank-list">
            <div className={styles.cardHead}>
              <h2 id="nen-rank-list" className={styles.cardTitle}>ランク</h2>
              <p className={styles.cardDesc}>上から高い順。行の「…」から消すと、そのランクの会員を移し先のランクへ反映します</p>
            </div>
            <div className={styles.rankHeadRow} aria-hidden="true">
              <span className={styles.rankColName}>ランク名</span>
              <span className={styles.rankColThreshold}>通年のしきい値</span>
              <span className={styles.rankColRate}>マイル還元</span>
              <span className={styles.rankColAction} />
            </div>
            {drafts.map((row, index) => {
              const isBase = index === drafts.length - 1 && parseYen(row.threshold) === 0
              const label = row.name.trim() || `ランク ${index + 1}`
              return (
                <div key={row.id ?? `new-${index}`} className={styles.rankRow} title={`タグ：${row.tagName ?? emptyValue('unconfigured')}・会員 ${formatNumber(row.memberCount)} 人`}>
                  <div className={styles.rankColName}>
                    <SaveErrorField names={[`drafts.${index}.name`,"row.name"]}><TextField {...fields.bind(`rank-name-${index}`)} aria-label={`ランク名 ${index + 1}`} value={row.name} maxLength={20} readOnly={readonly} onChange={(event) => update(index, { name: event.target.value })} /></SaveErrorField>
                    <FieldError id={`rank-name-${index}-error`}>{fields.error(`rank-name-${index}`)}</FieldError>
                  </div>
                  <div className={styles.rankColThreshold}>
                    {isBase ? (
                      <span className={styles.fixedBox} title="いちばん下のランクは ¥0 から（変えられません）">¥0〜（固定）</span>
                    ) : (
                      <SaveErrorField names={[`drafts.${index}.threshold`,"threshold","row.threshold"]}><NumberInput numericText {...fields.bind(`rank-threshold-${index}`)} aria-label={`しきい値 ${index + 1}`} inputMode="numeric" placeholder="¥0〜" value={row.threshold} readOnly={readonly} onChange={(event) => update(index, { threshold: event.target.value })} /></SaveErrorField>
                    )}
                    <FieldError id={`rank-threshold-${index}-error`}>{fields.error(`rank-threshold-${index}`)}</FieldError>
                  </div>
                  <div className={styles.rankColRate}>
                    <SaveErrorField names={[`drafts.${index}.rate`,"rate","row.rate"]}><TextField {...fields.bind(`rank-rate-${index}`)} aria-label={`マイル還元 ${index + 1}`} inputMode="decimal" placeholder="0%" value={row.rate} readOnly={readonly} onChange={(event) => update(index, { rate: event.target.value })} /></SaveErrorField>
                    <FieldError id={`rank-rate-${index}-error`}>{fields.error(`rank-rate-${index}`)}</FieldError>
                  </div>
                  <div className={styles.rankColAction}>
                    {/* 行の右端は「…」（タグを開く・ランクを削除する）。1つの機能の印にしない。 */}
                    <RowActions
                      subjectName={`ランク「${label}」`}
                      menuItems={row.tagId ? [{ id: 'tag', label: 'タグを開く', external: false, href: `/tags/edit?id=${encodeURIComponent(row.tagId ?? '')}`, onSelect: () => router.push(`/tags/edit?id=${encodeURIComponent(row.tagId ?? '')}`) }] : []}
                      destructiveItem={readonly ? undefined : {
                        id: 'delete',
                        label: 'ランクを削除する',
                        disabled: isBase || busy,
                        disabledReason: isBase ? 'いちばん下のランクは消せません' : undefined,
                        onSelect: () => askRemove(index),
                      }}
                    />
                  </div>
                </div>
              )
            })}
            {readonly ? null : (
              <div className={styles.addRow}>
                <Button variant="secondary" onClick={add} disabled={drafts.length >= MAX_RANKS}>
                  <Plus size={16} aria-hidden="true" />ランクを足す
                </Button>
              </div>
            )}
          </Card>
        </div>
      </DetailColumns>

      {readonly ? null : (
        <div className={styles.saveRow}>
          <Button variant="secondary" onClick={cancel} disabled={busy || !dirty} title={busy ? '処理しています' : !dirty ? '変更がありません' : undefined}>キャンセル</Button>
          <Button variant="primary" onClick={() => (conflict ? setComparing(true) : void save())} disabled={busy || (!dirty && !missingTags)} title={busy ? '処理しています' : !dirty && !missingTags ? '変更がありません' : undefined} busy={Boolean(busy)} busyLabel="処理中…">
            <Check size={16} aria-hidden="true" />{conflict ? '比べてから保存' : '保存して EC へ同期'}
          </Button>
        </div>
      )}

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="ランク設定への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />

      {/* dEv6G：会員がいるランクは移す先が必須（API の決まりと同じ）。 */}
      <Dialog
        open={removeTicket !== null && removeTarget !== null && removeAccount.current === activeAccount.current && removeRow !== null && removeRow.id !== null}
        designNode="dEv6G"
        size="medium"
        designTop={300}
        designHeaderPadding="var(--tpl-fm2-rank-dialog-head-pad)"
        confirmation
        tone="destructive"
        title={`ランク「${removeName}」を消しますか？`}
        busy={busy}
        actionWidthReserve="idle" confirmLabel={moving > 0 ? `${formatNumber(moving)} 人を移して消す` : '消す'}
        cancelLabel="キャンセル"
        onConfirm={!removePreview || removePreview.version !== settings.rules?.version || moving > 0 && !replacement ? undefined : () => removeRank(removeTicket)}
        onCancel={() => { removeContext.current = null; removeGeneration.current += 1; setRemovePreview(null); setRemoveTarget(null) }}
      >
        <OperationTargetSummary accounts={[{ id: accountId }]} />
        <div className={styles.removeBody}>
          {/* 説明は題の行（×と並ぶ）ではなく、窓の幅いっぱいに置く（dEv6G）。 */}
          <p className={styles.removeDesc}>
            {!removePreview ? removePreviewError ? '会員を確認できません。閉じてもう一度お試しください。' : '対象の会員を確認しています。' : removePreview.version!==settings.rules?.version ? 'ランク設定が変わりました。閉じて最新の状態を確認してください。' : moving > 0
              ? `このランクには会員が ${formatNumber(moving)} 人います。消す前に、移す先のランクを決めてください。`
              : 'このランクに会員はいません。消すと、ランクの一覧から外れます。'}
          </p>
          {moving > 0 ? (<>
            <Field label="移す先のランク" requirement={{ required: true }}>
              <SaveErrorField names={["replacement"]}><EntitySelect
                aria-label="移す先のランク（必須）"
                size="full"
                value={replacement}
                onChange={value => { if (value !== replacement && removeContext.current) removeContext.current.ticket = {}; setReplacement(value) }}
                options={[
                  { value: '', label: '移す先のランクを選ぶ' },
                  ...removeCandidates.map((row) => ({ ...entityOptionMetadata(row), value: row.id ?? '', label: row.name.trim() || '（名前なし）' })),
                ]}
              /></SaveErrorField>
            </Field>
            <Notice tone="warn">
              移し先のランクは、各会員のいまの有効期限まで使います。期限のあとは通常のランク判定に戻ります。ECへ反映したあと、次の購入から還元率が変わります。タグも付け替えます。

            </Notice>
          </>) : null}
        </div>
      </Dialog>

      {/* 違いを比べる：最新の保存といまの下書きを並べて見せる。 */}
      <Dialog
        open={comparing && conflict !== null}
        title="ランク設定の違い"
        description="左が最新の保存、右がいまの下書きです。よければ、この内容で保存できます。"
        confirmLabel="この内容で保存する"
        cancelLabel="閉じる"
        busy={busy}
        onConfirm={() => save(true)}
        onCancel={() => setComparing(false)}
      >
        {conflict ? (
          <div className={styles.diffGrid}>
            <div>
              <p className={styles.diffHead}>最新（{conflict.latest.rules ? shortDateTime(conflict.latest.rules.updatedAt) : emptyValue('unknown')}）</p>
              <ul className={styles.diffList}>
                {conflict.latest.ranks.map((rank) => (
                  <li key={rank.id}>{rank.name} — {thresholdText(rank.annualThresholdYen)} / {rateText(rank.mileRatePercent)}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className={styles.diffHead}>いまの下書き</p>
              <ul className={styles.diffList}>
                {drafts.map((row, index) => (
                  <li key={row.id ?? `draft-${index}`}>{row.name || '（名前なし）'} — {row.threshold || emptyValue('unknown')} / {row.rate || emptyValue('unknown')}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div></SaveErrorScope>
  )
}

function RuleBox({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.ruleBox}>
      <span className={styles.ruleLabel}>{label}</span>
      <span className={styles.ruleValue}>{value}</span>
    </div>
  )
}
