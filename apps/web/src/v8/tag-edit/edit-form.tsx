'use client'

import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { TagEditFormProps } from './edit-form-types'
export type { TagEditHost } from './edit-form-types'

import { SettingsFormRow } from '@/components/shared/settings-form-card';
import { Plus, Trash2, Check, ChevronDown, ChevronUp, GitCompare, TriangleAlert } from 'lucide-react';
import { RetroactiveDialog, type LinkedAction, type TagEditorValues } from '@/components/friend-fields/tag-editor-v4';
import KpiBand from '@/components/shared/kpi-band';
import KpiCard from '@/components/shared/kpi-card';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/components/shared/list-navigation';

import { api, type TagRetroactivePreview } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { StickyBarAction } from '@/components/shared/sticky-bar';
import { CreatePage } from '@/components/templates';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import Button from '@/components/shared/button'
import { RowMenu } from '@/components/shared/row-actions';
import Card, { CardHeader } from '@/components/shared/card';
import { SaveConflictBand } from '@/components/shared/save-conflict';
import HelpTip from '@/components/shared/help-tip';
import Notice from '@/components/shared/notice';
import { Field } from '@/components/shared/form-controls';
import { TextField } from '@/components/shared/text-field';
import { tagNameProblem } from '@/v8/tags/public/tag-name/index'
import { formatNumber } from '@/lib/format'
import Select from '@/components/shared/select';
import FolderSelect, { type FolderSelectCreate, type FolderDraftGuard } from '@/components/shared/folder-select';
import Toggle from '@/components/shared/toggle';
import { DuplicateNameNote, findDuplicateNames } from '@/components/friend-fields/attribute-kind-guide';
import LinkedActionList from '@/components/friend-fields/linked-action-list';
import { MULTIPLIERS, PRIORITIES, actionsSummary, buildUsageRows, mileageSummary } from './model';
import styles from './edit.module.css';
import { emptyValue } from '@/components/shared/empty-value';
import NumberInput from '@/components/shared/number-field';
import { SaveErrorField, useSaveErrorReveal } from '@/components/shared/save-form-errors';
import ReadOnlyNotice from '@/components/shared/read-only-notice';
import { requestUnsavedAction } from '@/lib/unsaved-action'

export function TagEditForm({
  tag,
  groups,
  onCreateGroup,
  dependencies,
  accountId,
  readOnly,
  conflict,
  compareBusy,
  onCompare,
  onReloadLatest,
  retroactiveReference,
  initialActions,
  saving,
  error,
  onCancel,
  onSave,
  onDelete,
  host,
}: TagEditFormProps) {
  const folderDraftGuard = useRef<FolderDraftGuard | null>(null)
  const [folderCreating, setFolderCreating] = useState(false)
  const guardFolder = (action: () => void) => { if (folderDraftGuard.current) folderDraftGuard.current(action); else action() }
  const [name, setName] = useState(tag.name ?? '')
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const [groupId, setGroupId] = useState(tag.groupId ?? '')
  const [isStarred, setIsStarred] = useState(tag.isStarred ?? false)
  const hasStoredLink = Boolean((tag.mileageReward ?? 0) || (tag.referralMileageReward ?? 0) || tag.mileageMultiplierBps)
  const [linked, setLinked] = useState(host?.initialValues.linked ?? tag.linkedEnabled ?? (hasStoredLink || initialActions.length > 0))
  const [reward, setReward] = useState(String(tag.mileageReward ?? 0))
  const [referralReward, setReferralReward] = useState(String(tag.referralMileageReward ?? 0))
  const [grantOn, setGrantOn] = useState((tag.mileageReward ?? 0) > 0 || (tag.referralMileageReward ?? 0) > 0)
  const [multiplier, setMultiplier] = useState(tag.mileageMultiplierBps == null ? '' : String(tag.mileageMultiplierBps))
  const [priority, setPriority] = useState(String(tag.mileageMultiplierPriority ?? 0))
  const [applyToExisting, setApplyToExisting] = useState(retroactiveReference)
  const [reapplyMode, setReapplyMode] = useState<'once' | 'every'>(tag.reapplyPolicy === 'every_time' ? 'every' : 'once')
  const [actions, setActions] = useState<LinkedAction[]>(initialActions)

  const [retroactiveOpen, setRetroactiveOpen] = useState(retroactiveReference)
  /* 畳んだ段。競合のときは、直した所が見えるように全部開く。 */
  const [actionsOpen, setActionsOpen] = useState(false)
  const [mileageOpen, setMileageOpen] = useState(retroactiveReference)
  useSaveErrorReveal(['reward', 'rewardMiles', 'mileageReward', 'mileage.self', 'tag.mileage.self', 'definition.tag.mileage.self',
    'referralReward', 'referralRewardMiles', 'referralMileageReward', 'mileage.referrer', 'tag.mileage.referrer', 'definition.tag.mileage.referrer',
    'multiplier', 'multiplierBps', 'mileageMultiplierBps', 'mileage.multiplier', 'tag.mileage.multiplier', 'definition.tag.mileage.multiplier',
    'priority', 'multiplierPriority', 'mileageMultiplierPriority', 'mileage.priority', 'tag.mileage.priority', 'definition.tag.mileage.priority'], () => setMileageOpen(true))
  useEffect(() => {
    if (!conflict) return
    setActionsOpen(true)
    setMileageOpen(true)
  }, [conflict])
  const actionsRef = useRef<HTMLElement>(null)

  /* IDEA-04：同名のタグがすでにあるとき、保存する前に知らせる。 */
  const duplicateSkip = Boolean(host) || readOnly
  const duplicateScope = useMemo(() => ({ accountId, skip: duplicateSkip }), [accountId, duplicateSkip])
  const [siblings, setSiblings] = useState<{ scope: typeof duplicateScope; state: 'ready' | 'error'; names: Array<{ id: string; name: string }> } | null>(null)
  const [siblingsRetry, setSiblingsRetry] = useState(0)
  useEffect(() => {
    if (duplicateScope.skip) return
    let cancelled = false
    setSiblings(null)
    void api.tags.list({ accountId: duplicateScope.accountId })
      .then((res) => {
        if (cancelled) return
        if (res.success) setSiblings({ scope: duplicateScope, state: 'ready', names: res.data.map(item => ({ id: item.id, name: item.name })) })
        else setSiblings({ scope: duplicateScope, state: 'error', names: [] })
      })
      .catch(() => { if (!cancelled) setSiblings({ scope: duplicateScope, state: 'error', names: [] }) })
    return () => { cancelled = true }
  }, [duplicateScope, siblingsRetry])
  const visibleSiblings = siblings?.scope === duplicateScope && siblings.state === 'ready' ? siblings.names : []
  const nameDuplicates = findDuplicateNames(visibleSiblings, name, tag.id)
  const duplicateFailed = !duplicateScope.skip && siblings?.scope === duplicateScope && siblings.state === 'error'

  const fingerprint = JSON.stringify({ name, groupId, isStarred, linked, reward, referralReward, multiplier, priority, applyToExisting, reapplyMode, actions })
  const baseline = useRef({ version: tag.version, fingerprint })
  if (baseline.current.version !== tag.version) baseline.current = { version: tag.version, fingerprint }
  const groupName = groups.find((group) => group.id === groupId)?.name ?? '未分類'
  const values = useMemo<TagEditorValues>(() => ({
    name: name.trim(), groupId, isStarred, linked,
    rewardMiles: linked ? Number(reward) || 0 : 0,
    referralRewardMiles: linked ? Number(referralReward) || 0 : 0,
    multiplierBps: linked && multiplier ? Number(multiplier) : null,
    multiplierPriority: linked ? Number(priority) || 0 : 0,
    applyToExisting,
    reapplyPolicy: reapplyMode === 'every' ? 'every_time' : 'first_only',
    actions: linked ? actions : [],
  }), [name, groupId, isStarred, linked, reward, referralReward, multiplier, priority, applyToExisting, reapplyMode, actions])

  /* N-047：いま付いている人への反映の人数はサーバーで数える。入力中は少し待ってから数え直す。 */
  const [retroPreview, setRetroPreview] = useState<TagRetroactivePreview | null>(null)
  useEffect(() => {
    if (retroactiveReference || host) return
    const timer = setTimeout(() => {
      void api.tags.retroactivePreview(tag.id, accountId, { self: values.rewardMiles, referrer: values.referralRewardMiles })
        .then((res) => { if (res.success) setRetroPreview(res.data) })
        .catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [tag.id, accountId, values.rewardMiles, values.referralRewardMiles, retroactiveReference, host])

  /* ★V8 zOc7f：マイルを付ける動きの重なりと、大量付与の確かめ。 */
  const grantAmounts = (linked ? actions : []).flatMap((action) => {
    const amount = Number((action.definition?.params as { amount?: unknown } | undefined)?.amount)
    return action.definition?.type === 'grant_mileage' && amount > 0 ? [amount] : []
  })
  const overlapAmounts = [...(reward.trim() && Number(reward) > 0 ? [Number(reward)] : []), ...grantAmounts]
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkTried, setBulkTried] = useState(false)
  const bulkLockedReason = usePermissionLockReason(!readOnly)
  const bulkOk = useRef(false)
  const bulkPeople = tag.friendCount ?? 0
  const requestSave = () => {
    if (readOnly) return
    const problem = tagNameProblem(name)
    if (problem) { setNameError(problem); nameRef.current?.focus(); nameRef.current?.scrollIntoView({ block: 'center' }); return }
    setNameError('')
    if (grantAmounts.length > 0 && bulkPeople >= 1000 && !bulkOk.current) {
      setBulkTried(false); setBulkOpen(true)
      return
    }
    if (applyToExisting && (tag.friendCount ?? 0) > 0 && (values.rewardMiles > 0 || values.referralRewardMiles > 0)) {
      setRetroactiveOpen(true)
      return true
    }
    return onSave(values, false)
  }

  /* 使っている所：削除の影響確認と同じ数え方（dependencies）。取れないときはタグの一覧の数。 */
  const usageRows = buildUsageRows(dependencies, tag.usedIn)
  /* このタグが付く物（絵 zOc7f）：自動応答・回答フォーム・オートメーションなど、付ける側。 */
  const grantAttachers = usageRows.filter((row) => ['自動応答', '回答フォーム', 'オートメーション', '友だち追加時の配信', '流入リンク', '友だち追加の経路'].includes(row.label) && row.count > 0)
  /* 競合の帯は共通部品（save-conflict）。絵は （頭の説明の下・横いっぱい）。 */
  const conflictBand = conflict ? (
    <div className={styles.conflictSlot}>
      <SaveConflictBand
        title={`ほかの人がタグ「${tag.name}」を先に保存しました`}
        reloadVariant="primary" designNode="xn95q"
        compareBusy={compareBusy}
        onCompare={onCompare}
        onReload={() => requestUnsavedAction(onReloadLatest)}
      />
    </div>
  ) : null

  const side = (
    <div className={styles.side}>
      <div className={styles.sideHead}>
        <h2 className={styles.sideTitle}>使っている所</h2>
      </div>
      <dl className={styles.useList}>
        {usageRows.map((row) => (
          <div key={row.label} className={styles.useRow}>
            <dt>{row.label}</dt>
            <dd>
              {row.count > 0 && row.href
                ? <Link href={row.href} className={styles.useLink}>{`${formatNumber(row.count)} 件 →`}</Link>
                : <span className={row.count > 0 ? styles.useCount : styles.useNone}>{row.count > 0 ? `${formatNumber(row.count)} 件` : row.known ? emptyValue('none') : emptyValue('unknown')}</span>}
            </dd>
          </div>
        ))}
        <div className={styles.useRow}>
          <dt>タグ連動</dt>
          <dd>
            {linked && actions.length > 0 ? (
              <button type="button" className={styles.useLink} onClick={() => { setActionsOpen(true); window.requestAnimationFrame(() => actionsRef.current?.scrollIntoView({ block: 'start' })) }}>
                {`${actions.length} つ →`}
              </button>
            ) : <span className={styles.useNone}>{emptyValue('none')}</span>}
          </dd>
        </div>
      </dl>
      <Notice tone="info" icon={<TriangleAlert size={16} aria-hidden="true" />}>
        <span>このタグを消すと、上の配信やフォームの条件から外れます。消す前に確認が出ます。</span>
      </Notice>
    </div>
  )

  return (
    <div className={styles.page}>
      <CreatePage
        dirty={!readOnly && fingerprint !== baseline.current.fingerprint}
        busy={saving}
        boardId={host ? 'MFgPZ' : 'Qat9s'}
        footerOutlined={Boolean(host)}
        notice={<>{host?.notice}{readOnly ? <div className={styles.roBand}><ReadOnlyNotice role="note" data-design-node="fkGUR">{host ? '閲覧のみで見ています。変える操作は統括の管理者に頼んでください。' : '閲覧のみで見ています。変える操作はオーナーか管理者に頼んでください。'}</ReadOnlyNotice></div> : null}{conflictBand}</>}
        title={host?.title ?? (tag.name || 'タグを編集')}
        identity={host ? undefined : <></>}
        actions={!host && !readOnly ? <RowMenu label="タグの操作" items={[{ id: 'duplicate', label: '複製して作る', href: `/tags/new?copy=${tag.id}` }]} /> : undefined}
        help={host?.description ?? `${groupName}フォルダ・${tag.friendCount ?? 0}人に付いている・${formatDay(tag.createdAt)}作成`}
        previewLabel="使用状況を見る"
        previewTitle="使っている所"
        preview={host ? host.preview(values) : side}
        destructive={host || readOnly ? undefined : <StickyBarAction destructive label="タグを削除する" icon={Trash2} disabledReason={folderCreating ? "フォルダを作成中です。" : undefined} onClick={() => requestUnsavedAction(onDelete)} />}
        footerActions={(
          <>
            <Button disabled={folderCreating} disabledReason={folderCreating ? "フォルダを作成中です。" : undefined} onClick={() => requestUnsavedAction(onCancel)}>キャンセル</Button>
            {/* 閲覧のみには押せない操作を置かない（隠す）。 */}
            {readOnly ? null : <>{host?.onSaveDraft ? <Button busy={folderCreating} busyLabel="フォルダ作成中" disabled={saving || !name.trim()} disabledReason={!name.trim() ? 'タグの名前を入れてください' : undefined} onClick={() => guardFolder(() => host.onSaveDraft?.(values))}>下書きを保存</Button> : null}{host ? <Button busy={folderCreating} busyLabel="フォルダ作成中" disabled={saving || !name.trim()} disabledReason={!name.trim() ? 'タグの名前を入れてください' : undefined} onClick={() => guardFolder(() => host.onSaveAnother(values))}><Plus size={16} aria-hidden="true" />保存して続けて作る</Button> : null}</>}
            {readOnly ? null : (
              <Button variant="primary" onClick={() => guardFolder(() => { if (conflict) onCompare(); else void requestSave() })} busy={saving || folderCreating} busyLabel={folderCreating ? "フォルダ作成中" : "保存中…"} disabled={Boolean(host) && !name.trim()} disabledReason={!name.trim() ? 'タグの名前を入れてください' : undefined}>
                {conflict ? <GitCompare size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                {conflict ? '比べてから保存' : host ? host.saveLabel ?? 'タグを作る' : 'タグを保存する'}
              </Button>
            )}
          </>
        )}
      >
        {error ? <Notice tone="danger" message={error} /> : null}
        {/* 閲覧のみには入力の部品・押す口を置かず、いまの値を文字で見せる（2026-10-06 オーナー決定）。 */}
        <fieldset disabled={saving} className={styles.fieldset}>
          <Card variant="form" gap="normal" aria-label="基本">
            <CardHeader size="stacked" title="基本" />
            <div className={styles.field}><Field required error={nameError || undefined} label="タグ名" htmlFor="tag-edit-name">{readOnly ? <span className={styles.roValue}>{name}</span> : <SaveErrorField names={["name", "tag.name", "definition.tag.name"]}><TextField id="tag-edit-name" ref={nameRef} value={name} onChange={(event) => { setName(event.target.value); setNameError('') }} placeholder="例：定期購入者" aria-required="true" /></SaveErrorField>}
<DuplicateNameNote duplicates={nameDuplicates} kindLabel="タグ" />
{duplicateFailed ? <Notice tone="warn" action={<Button onClick={() => setSiblingsRetry(n => n + 1)}>重複を確認し直す</Button>}>同じ名前のタグを確認できませんでした。</Notice> : null}</Field></div>
            <div className={styles.field}>
              <span className={styles.label}>所属フォルダ</span>
              <div className={styles.folderBox}>
                {readOnly
                  ? <span className={styles.roValue}>{groups.find((group) => group.id === groupId)?.name ?? '未分類'}</span>
                  : <SaveErrorField names={["groupId", "group_id", "folderId", "tag.folderId", "definition.tag.folderId"]}><FolderSelect draftGuardRef={folderDraftGuard} onCreatingChange={setFolderCreating} aria-label="所属フォルダ" value={groupId} onChange={setGroupId} folders={groups.map((group) => ({ value: group.id, label: group.name, color: group.color }))} onCreate={onCreateGroup} size="full" /></SaveErrorField>}
              </div>
            </div>
            <div className={styles.switchRow}>
              <div className={styles.switchText}>
                <span className={styles.label}>友だち一覧に出す</span>
                <span className={styles.hint}>オンにすると、友だち一覧の名前の下にこのタグが出ます</span>
              </div>
              {readOnly ? <span className={styles.linkedState}>{isStarred ? 'オン' : 'オフ'}</span> : <SaveErrorField names={["isStarred","is_starred"]}><Toggle checked={isStarred} onChange={setIsStarred} label="友だち一覧に出す" /></SaveErrorField>}
            </div>
          </Card>

          <section aria-label="タグ連動" ref={actionsRef}>
            <Card variant="form" gap="normal">
            <CardHeader size="stacked" title={host ? <HelpTip label="タグ連動の説明" trigger="タグ連動（このタグが付いたときの動き）">オフのままでも、タグの手動付与・配信の絞り込み・シナリオの条件には使えます。オフに戻すと、これ以降このタグが付いても連動は動きません。すでに積んだマイルは取り消されません。<p>タグは分類の目印、友だち情報欄は名前・日付・回答などの値、対応マークは対応の状態、保存した検索は複数の条件をまとめて探すときに使います。</p></HelpTip> : 'タグ連動（このタグが付いたときの動き）'} help={host ? undefined : <HelpTip label="タグ連動の説明">オフのままでも、タグの手動付与・配信の絞り込み・シナリオの条件には使えます。オフに戻すと、これ以降このタグが付いても連動は動きません。すでに積んだマイルは取り消されません。<p>タグは分類の目印、友だち情報欄は名前・日付・回答などの値、対応マークは対応の状態、保存した検索は複数の条件をまとめて探すときに使います。</p></HelpTip>}
              meta="上から順に動きます。並べ替えは上下の印で"
              action={<span className={styles.actionPair}><span className={styles.linkedState}>{linked ? 'オン' : 'オフ'}</span>{readOnly ? null : <SaveErrorField names={["linked", "linkedEnabled", "tag.linkedEnabled"]}><Toggle checked={linked} onChange={setLinked} label="タグ連動" /></SaveErrorField>}</span>} />
            {actionsOpen ? <div className={styles.summaryRow}><span className={styles.titleSpacer} /><Button variant="text" onClick={() => setActionsOpen(false)} aria-expanded>閉じる<ChevronUp size={16} aria-hidden="true" /></Button></div> : (
              <div className={styles.summaryRow}>
                <span className={styles.summaryText}>{host && actions.length === 0 ? 'まだありません。［開く］から連動アクションを足せます' : actionsSummary(actions, linked)}</span>
                <span className={styles.titleSpacer} />
                <Button variant="text" onClick={() => setActionsOpen(true)} aria-expanded={false}>開く<ChevronDown size={16} aria-hidden="true" /></Button>
              </div>
            )}
            {actionsOpen ? (
              <>
                {linked || host ? (
                  <>
                    <LinkedActionList value={actions} onChange={next => { if (host && next.length > actions.length) setLinked(true); setActions(next) }} accountId={host ? null : accountId} allowedTypes={host?.allowedActionTypes} readOnly={readOnly} />
                    {overlapAmounts.length >= 2 && grantAmounts.length >= 1 ? <Notice tone="warn" message={`同じタグで マイル ${overlapAmounts.join('＋')} が付きます（合わせて ${overlapAmounts.reduce((a, b) => a + b, 0)} マイル）。重ねたくないときは、動きを 1 つにしてください。`} /> : null}
                  </>
                ) : <p className={styles.emptyBox}>連動はオフです。右上のスイッチをオンにすると、付いたときの動きとマイルを決められます。</p>}
              </>
            ) : null}
            </Card>
          </section>

          {linked || host ? (
            <Card variant="form" gap="normal" aria-label="マイル">
              <CardHeader size="stacked" title="マイル" meta="このタグが付いている人の、これからのマイルの倍率" />
              {mileageOpen ? <div className={styles.summaryRow}><span className={styles.titleSpacer} /><Button variant="text" onClick={() => setMileageOpen(false)} aria-expanded>閉じる<ChevronUp size={16} aria-hidden="true" /></Button></div> : (
                <div className={styles.summaryRow}>
                  <span className={styles.summaryText}>{host && !multiplier && !Number(reward) && !Number(referralReward) ? '変えない（ひな形の既定）' : mileageSummary(multiplier, Number(reward) || 0, Number(referralReward) || 0)}</span>
                  <span className={styles.titleSpacer} />
                  <Button variant="text" onClick={() => setMileageOpen(true)} aria-expanded={false}>開く<ChevronDown size={16} aria-hidden="true" /></Button>
                </div>
              )}
              {mileageOpen ? (
                <>
                  <SettingsFormRow layout="columns">
                    <div className={styles.field}>
                      <span className={styles.label}>今後のマイル倍率</span>
                      {readOnly
                        ? <span className={styles.roValue}>{MULTIPLIERS.find((option) => option.value === multiplier)?.label ?? '倍率を設定しない'}</span>
                        : <div className={styles.selectBox}><SaveErrorField names={["multiplier", "multiplierBps", "mileageMultiplierBps", "mileage.multiplier", "tag.mileage.multiplier", "definition.tag.mileage.multiplier"]}><Select aria-label="今後のマイル倍率" value={multiplier} onChange={setMultiplier} options={MULTIPLIERS} size="full" /></SaveErrorField></div>}
                    </div>
                    <div className={styles.field}>
                      <span className={styles.label}>倍率の優先度</span>
                      {readOnly
                        ? <span className={styles.roValue}>{PRIORITIES.find((option) => option.value === priority)?.label ?? '標準'}</span>
                        : <div className={styles.selectBox}><SaveErrorField names={["priority", "multiplierPriority", "mileageMultiplierPriority", "mileage.priority", "tag.mileage.priority", "definition.tag.mileage.priority"]}><Select aria-label="倍率の優先度" value={priority} onChange={setPriority} options={PRIORITIES} size="full" /></SaveErrorField></div>}
                    </div>
                  </SettingsFormRow>
                  {host ? null : <div className={styles.switchRow}>
                    <div className={styles.switchText}>
                      <span className={styles.label}>今付いている人にもさかのぼって積む（倍率は次の付与から）</span>
                      <span className={styles.hint}>{`オンにすると、すでに付いている ${tag.friendCount ?? 0} 人にも本人・紹介者のマイルをさかのぼって積みます（倍率は次の付与から）。積む前に人数の確認が開きます`}</span>
                    </div>
                    {readOnly ? <span className={styles.linkedState}>{applyToExisting ? 'オン' : 'オフ'}</span> : <SaveErrorField names={["applyToExisting","apply_to_existing"]}><Toggle checked={applyToExisting} onChange={setApplyToExisting} label="さかのぼって反映" /></SaveErrorField>}
                  </div>
                  }
                  {applyToExisting ? (
                    <KpiBand density="compact">
                      <KpiCard icon={null} title="現在の対象者" value={tag.friendCount ?? 0} unit="人" detail={null} />
                      <KpiCard icon={null} title="本人マイル対象" value={retroPreview ? retroPreview.selfTargets : retroactiveReference ? tag.friendCount ?? 0 : null} unit="人" detail={null} />
                      <KpiCard icon={null} title="紹介者対象" value={retroPreview?.referralTargets} unit="人" detail={null} />
                    </KpiBand>
                  ) : null}
                  {retroPreview && (retroPreview.selfExcluded > 0 || retroPreview.referralExcluded > 0) ? (
                    <p className={styles.hint}>{`すでに付与済みの人（本人${retroPreview.selfExcluded} 人・紹介者${retroPreview.referralExcluded} 人）は対象から外れています。`}</p>
                  ) : null}
                </>
              ) : null}
            </Card>
          ) : null}
          {linked || host ? (
            <Card variant="form" gap="normal" aria-label="このタグが付いたらマイル">
              <CardHeader size="stacked" title="このタグが付いたらマイル" meta="付いた本人（と紹介者）に、一度だけマイルを足します"
                action={readOnly ? <span className={styles.linkedState}>{grantOn ? 'オン' : 'オフ'}</span> : <Toggle checked={grantOn} onChange={(next) => { setGrantOn(next); if (!next) { setReward('0'); setReferralReward('0') } else if (!(Number(reward) > 0)) setReward('100') }} label="このタグが付いたらマイル" />} />
              {grantOn ? (
                <>
                  <SettingsFormRow layout="columns">
                    <Field note={<>このタグが付いた本人へ、一度だけ積みます。</>} label="本人へのマイル付与"><span className={styles.numberRow}>{readOnly ? <span className={styles.roValue}>{reward || '0'}</span> : <SaveErrorField names={["reward", "rewardMiles", "mileageReward", "mileage.self", "tag.mileage.self", "definition.tag.mileage.self"]}><NumberInput unit="マイル" type="number" min={0} value={reward} onChange={(event) => setReward(event.target.value)} /></SaveErrorField>}{readOnly ? <span className={styles.unit}>マイル</span> : null}</span>
</Field>
                    <Field note={<>紹介経由の友だちなら、その紹介者にも積みます。</>} label="紹介者へのマイル付与"><span className={styles.numberRow}>{readOnly ? <span className={styles.roValue}>{referralReward || '0'}</span> : <SaveErrorField names={["referralReward", "referral_reward", "referralRewardMiles", "referralMileageReward", "mileage.referrer", "tag.mileage.referrer", "definition.tag.mileage.referrer"]}><NumberInput unit="マイル" type="number" min={0} value={referralReward} onChange={(event) => setReferralReward(event.target.value)} /></SaveErrorField>}{readOnly ? <span className={styles.unit}>マイル</span> : null}</span>
</Field>
                  </SettingsFormRow>
                  <div className={styles.switchRow}>
                    <div className={styles.switchText}><span className={styles.label}>1 人 1 回だけ</span><span className={styles.hint}>タグを外して付け直したときの扱い：外して付け直しても足しません（外すと、付け直すたびに足します）。</span></div>
                    {readOnly ? <span className={styles.linkedState}>{reapplyMode === 'once' ? 'オン' : 'オフ'}</span> : <SaveErrorField names={["reapplyMode"]}><Toggle checked={reapplyMode === 'once'} onChange={(next) => setReapplyMode(next ? 'once' : 'every')} label="1 人 1 回だけ" /></SaveErrorField>}
                  </div>
                  {grantAttachers.length > 0 ? (
                    <div className={styles.attachBox}>
                      <p className={styles.subTitle}>{`このタグが付く物（${grantAttachers.reduce((sum, row) => sum + row.count, 0)}）`}</p>
                      {grantAttachers.map((row) => <p key={row.label} className={styles.hint}>{`${row.label} ${formatNumber(row.count)} 件`}</p>)}
                    </div>
                  ) : null}
                </>
              ) : null}
            </Card>
          ) : null}
        </fieldset>
      </CreatePage>

      <ConfirmDialog
        open={bulkOpen}
        title={`${bulkPeople.toLocaleString('ja-JP')} 人に付きます。保存しますか？`}
        description={`マイルを付ける動きがあります。このタグが付いている ${bulkPeople.toLocaleString('ja-JP')} 人に関わります。付けたマイルは自動では戻せません。`}
        confirmLabel="保存する"
        busy={saving} error={(bulkTried ? error : undefined) || nameError || undefined} confirmDisabled={readOnly || conflict} confirmLockedReason={bulkLockedReason} confirmDisabledReason="閉じて最新の内容と比べてください。" onSuccess={() => setBulkOpen(false)} onConfirm={() => { setBulkTried(true); bulkOk.current = true; try { return requestSave() } finally { bulkOk.current = false } }}
        onCancel={() => setBulkOpen(false)}
      />
      {retroactiveOpen ? (
        <RetroactiveDialog
          referenceState={retroactiveReference}
          values={values}
          count={tag.friendCount ?? 0}
          tagId={tag.id}
          accountId={accountId}
          onCancel={() => setRetroactiveOpen(false)}
          onSaveWithoutApplying={() => { setRetroactiveOpen(false); void onSave({ ...values, applyToExisting: false }, false) }}
          onSave={(previewToken) => { setRetroactiveOpen(false); void onSave(values, true, previewToken) }}
        />
      ) : null}
    </div>
  )
}
