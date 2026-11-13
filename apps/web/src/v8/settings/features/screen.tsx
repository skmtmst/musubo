'use client'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { DetailContent, DetailFields, DetailSection } from '@/components/shared/detail-content'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, ChevronDown, ChevronRight, GitCompare, Lock, RotateCcw, Save, Star } from 'lucide-react'
import Button from '@/components/shared/button'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { ReorderDialog } from './reorder-dialog'
export { ReorderDialog } from './reorder-dialog'
import ListState from '@/components/shared/list-state'
import Toggle, { ToggleGroupActions } from '@/components/shared/toggle'
import Card from '@/components/shared/card'
import { DialogContentRow } from '@/components/shared/dialog-form-row'
import { RowMenu } from '@/components/shared/row-actions'
import SearchField from '@/components/shared/search-field'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useAccountStyle } from '@/hooks/use-account-style'
import { groupEnabledCount, groupFeatureCount, itemIsEnabled, type FeatureGroup, type FeatureItem } from '@/lib/feature-settings'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import { FEATURE_SETTINGS_CONFLICT_MESSAGE } from './feature-settings-view'
import { groupSummary, shortUsageDate, useFeatureSettings, type FeatureUsage, type UsageCategory } from './use-feature-settings'
import '@/components/shared/favorite-button-tokens.css'
import styles from './screen.module.css'

import { SaveErrorField } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

/*
 * ★V8 機能設定（Pencil ・1152 ・競合 ・状態の見本帳 ）。
 *
 * 動き（読み込み・保存・競合・オフ前の影響確認・離脱の番兵・初期値に戻す・並びを変える）は
 * 今までの V8（app/settings/feature-settings-v8.tsx）と同じ。処理は同じ場所の
 * use-feature-settings.ts（写し）に1つだけ置く。見た目だけを型（SettingsPage）と部品で組み直した。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

const TITLE = '機能設定'
const DESCRIPTION = '使わない機能をオフにすると、左のメニューから消えます。作ったデータは消えません'

/** 区分ごとの利用数（オン/オフを持たない項目用）。行の名前の横に小さく出す。 */
function UsageBadge({ category, onRetry }: { category: UsageCategory; onRetry?: () => void }) {
  const created = category.created.value
  const inUse = category.inUse.value
  if (created === null || inUse === null) {
    return (
      <span className={styles.usage} title={category.inUse.reason ?? category.created.reason ?? '利用状況はまだ分かりません'}>
        —
        {onRetry && <button type="button" onClick={onRetry} aria-label="利用数を読み直す">もう一度読み込む</button>}
      </span>
    )
  }
  return (
    <span className={styles.usage} title={`${category.label}：作成 ${created}、利用中 ${inUse}`}>
      利用中 {inUse} / 作成 {created}
    </span>
  )
}

function FeatureUsageBadge({ usage, label, onRetry }: { usage: FeatureUsage; label: string; onRetry?: () => void }) {
  const { activity, activityBasis, activityUnit, lastUsedAt } = usage
  const lastUsed = lastUsedAt.value ? shortUsageDate(lastUsedAt.value) : null
  const title = `${label}：${[
    lastUsed ? `最終利用 ${lastUsed}` : null,
    lastUsedAt.reason && !lastUsed ? lastUsedAt.reason : null,
    activity.reason ?? null,
  ].filter(Boolean).join('・') || '利用状況'}`
  if (activity.state === 'failed') {
    return (
      <span className={styles.usage} title={title}>
        利用状況は取得失敗
        {onRetry && <button type="button" onClick={onRetry} aria-label="利用状況を読み直す">もう一度読み込む</button>}
      </span>
    )
  }
  if (activity.value === null) {
    return (
      <span className={styles.usage} title={`${title}（${activity.reason ?? lastUsedAt.reason ?? 'この機能の利用は計測していません'}）`}>
        利用状況は未計測
      </span>
    )
  }
  if (activityBasis === 'current') return <span className={styles.usage} title={title}>{activityUnit} {activity.value}</span>
  if (activity.value === 0 && lastUsed) {
    return <span className={styles.usage} title={`${label}：直近90日の${activityUnit}は0・最終利用 ${lastUsed}`}>最終利用 {lastUsed}</span>
  }
  return <span className={styles.usage} title={title}>90日で {activity.value}{activityUnit}</span>
}

function FeatureRow({ item, features, usage, featureUsage, usageRetry, sharedSwitch, canManage, lockedReason, busy, onToggle, favorite, showFavorite, onFavoriteToggle }: {
  item: FeatureItem
  features: Record<string, boolean>
  usage?: UsageCategory
  featureUsage?: FeatureUsage
  usageRetry?: () => void
  sharedSwitch: boolean
  canManage: boolean
  lockedReason?: string
  busy?: boolean
  onToggle: (item: FeatureItem, next: boolean) => void
  favorite?: boolean
  showFavorite?: boolean
  onFavoriteToggle?: (itemId: string) => void
}) {
  const enabled = itemIsEnabled(item, features)
  return (
    <li className={styles.row}>
      <div className={styles.rowText}>
        <p className={styles.rowName}>
          <span className={styles.rowLabel} title={item.label}>{item.label}</span>
          {sharedSwitch && <span className={styles.rowTag}>同じスイッチ</span>}
          {item.badge && <span className={styles.rowTag}>{item.badge}</span>}
          {featureUsage && <FeatureUsageBadge usage={featureUsage} label={item.label} onRetry={usageRetry} />}
          {!featureUsage && usage && <UsageBadge category={usage} onRetry={usageRetry} />}
        </p>
        <p className={styles.rowNote}>{item.note}</p>
      </div>
      {showFavorite && <span data-disabled={busy || !canManage ? "" : undefined}><button type="button" data-part="favorite-star" className={`${styles.favoriteButton} ${favorite ? styles.favoriteActive : ''}`}
        aria-label={`${item.label}をお気に入り${favorite ? 'から外す' : 'に入れる'}`}
        aria-pressed={favorite} disabled={busy || !canManage} onClick={() => onFavoriteToggle?.(item.id)}>
        <Star aria-hidden="true" />
      </button></span>}
      {item.required ? (
        <span className={styles.required} title={`${item.label}は必須機能のため、オフにできません`}>
          <Lock className={styles.requiredIcon} aria-hidden="true" />
          消せない
        </span>
      ) : (
        <SaveErrorField names={["enabled"]}><Toggle
          checked={enabled}
          label={`${item.label}を${enabled ? 'オフ' : 'オン'}にする`}
          disabled={busy || !canManage}
          lockedReason={lockedReason}
          onChange={(next) => { if (canManage) onToggle(item, next) }}
        /></SaveErrorField>
      )}
    </li>
  )
}

/** 既定で開く区分（絵では「メイン」「配信」「設定」が開いている）。 */
/* 絵（・）では、最初に開いているのはメインと配信だけ。 */
const DEFAULT_OPEN = new Set(['basic', 'delivery'])
/** 絵の並び：「設定」の区分はいちばん下（飲食店向けのあと）。ほかは今までの並びのまま。 */
const LAST_GROUP_IDS = ['settings']
function settingsGroupLast<T extends { id: string }>(groups: T[]): T[] {
  return [...groups.filter((group) => !LAST_GROUP_IDS.includes(group.id)), ...groups.filter((group) => LAST_GROUP_IDS.includes(group.id))]
}

function FeatureGroupCard({ group, features, usageByItemId, usageByFeatureId, usageRetry, open, canManage, lockedReason, busy, onOpenChange, onItemToggle, onGroupToggle, favorites, showFavorites, onFavoriteToggle }: {
  group: FeatureGroup
  features: Record<string, boolean>
  usageByItemId: Map<string, UsageCategory>
  usageByFeatureId: Map<string, FeatureUsage>
  usageRetry?: () => void
  open: boolean
  canManage: boolean
  lockedReason?: string
  busy?: boolean
  onOpenChange: (open: boolean) => void
  onItemToggle: (item: FeatureItem, next: boolean) => void
  onGroupToggle: (group: FeatureGroup, next: boolean) => void
  favorites?: string[]
  showFavorites?: boolean
  onFavoriteToggle?: (itemId: string) => void
}) {
  const total = groupFeatureCount(group)
  const enabled = groupEnabledCount(group, features)
  const switchCount = new Map<string, number>()
  for (const item of group.items) {
    const key = item.keys[0]
    if (key) switchCount.set(key, (switchCount.get(key) ?? 0) + 1)
  }
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Card overflow="hidden" aria-label={group.label}>
      <div className={styles.groupHead}>
        <button
          type="button"
          className={styles.groupToggle}
          data-hit-area=""
          aria-expanded={open}
          aria-label={`${group.label}を${open ? '畳む' : '開く'}`}
          onClick={() => onOpenChange(!open)}
        >
          <Chevron className={styles.chevron} aria-hidden="true" />
        </button>
        <h2 className={styles.groupTitle}>{group.label}</h2>
        {total === 0 && <span className={styles.groupMeta}>{canManage ? groupSummary(group, features) : '消せません'}</span>}
        <span className={styles.spacer} />
        {total > 0 && (
          <ToggleGroupActions total={total} enabled={enabled} label={group.label} disabled={busy || !canManage} lockedReason={lockedReason}
            disabledReason={busy ? '変更を反映しています' : null}
            onChange={(next) => { if (canManage) onGroupToggle(group, next) }} />
        )}
      </div>
      {open && (
        <ul className={styles.rows}>
          {group.items.map((item) => (
            <FeatureRow
              key={item.id}
              item={item}
              features={features}
              usage={item.keys.length === 0 ? usageByItemId.get(item.id) : undefined}
              featureUsage={item.keys[0] ? usageByFeatureId.get(item.keys[0]) : undefined}
              usageRetry={usageRetry}
              sharedSwitch={Boolean(item.keys[0]) && (switchCount.get(item.keys[0]) ?? 0) > 1}
              canManage={canManage}
              lockedReason={lockedReason}
              busy={busy}
              onToggle={onItemToggle}
              favorite={favorites?.includes(item.id)}
              showFavorite={showFavorites}
              onFavoriteToggle={onFavoriteToggle}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function FeatureSettingsScreen() {
  const settings = useFeatureSettings()
  const {
    selectedAccountId,
    features,
    savedFeatures,
    groups,
    dirty,
    loading,
    saving,
    error,
    loadFailed,
    reason,
    setReason,
    setError,
    itemOrder,
    setItemOrder,
    moveItemInOrder,
    discardChanges,
    resetToDefaults,
    resetToDefaultsOpen,
    setResetToDefaultsOpen,
    save,
    usageByItemId,
    usageByFeatureId,
    usageFailed,
    loadUsage,
    load,
    toggleItem,
    toggleGroup,
    impactOpen,
    setImpactOpen,
    impactGroups,
    impactBusy,
    impactError,
    setImpactError,
    confirmImpactSave,
    impactSummary,
    featureLabelByKey,
    leaveTarget,
    confirmLeave,
    cancelLeave,
    setSavedFeatures,
    setSavedItemOrder,
    favorites,
    savedFavorites,
    toggleFavorite,
    setSavedFavorites,
    currentOrder,
  } = settings
  const accountScope = useRef({ id: selectedAccountId })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId }
  const impactScope = useRef<{ scope: typeof accountScope.current; id: string | null } | null>(null)
  if (!impactOpen) impactScope.current = null
  else if (!impactScope.current) impactScope.current = { scope: accountScope.current, id: selectedAccountId }
  const renderedImpactScope = impactScope.current
  const accountStyle = useAccountStyle(selectedAccountId)
  const showEcCommerce = accountStyle.status === 'ready' && accountStyle.data?.style === 'ec' && accountStyle.data.styleSelected === true
  const styleGroups = useMemo(() => groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== 'ec-commerce' || showEcCommerce),
  })).filter((group) => group.items.length > 0), [groups, showEcCommerce])

  /* 本人未確認は通常disabled。確認後の権限拒否は共通の灰色と理由で示す。 */
  const staffRole = useStaffRole()
  const permissionReason = usePermissionLockReason(canManageRole(staffRole), 'manager')
  const canManage = canManageRole(staffRole) && !permissionReason

  const [query, setQuery] = useListUrlValue('q', '')
  const [compareOpen, setCompareOpen] = useState(false)
  const [reorderOpen, setReorderOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<Set<string> | null>(null)
  const conflicted = error === FEATURE_SETTINGS_CONFLICT_MESSAGE
  useEffect(() => { setCompareOpen(false); setReorderOpen(false) }, [selectedAccountId])
  // 権限を失っても下書きは保ち、変更中の窓だけ閉じる。
  useEffect(() => {
    if (canManage) return
    setCompareOpen(false)
    setReorderOpen(false)
    setResetToDefaultsOpen(false)
    setImpactOpen(false)
  }, [canManage, setResetToDefaultsOpen, setImpactOpen])

  /* 保存ボタンは「保存中 → ✓ 保存しました」でボタンの中だけ変わる。 */
  const [savedTick, setSavedTick] = useState(false)
  const wasSavingRef = useRef(false)
  useEffect(() => {
    if (saving) {
      wasSavingRef.current = true
      return
    }
    if (wasSavingRef.current && !dirty) setSavedTick(true)
    wasSavingRef.current = false
  }, [saving, dirty])
  useEffect(() => {
    if (dirty) setSavedTick(false)
  }, [dirty])

  const filteredGroups = useMemo(() => {
    const q = query.trim()
    if (!q) return settingsGroupLast(styleGroups)
    return settingsGroupLast(styleGroups)
      .map((group) => ({ ...group, items: group.items.filter((item) => item.label.includes(q) || item.note.includes(q)) }))
      .filter((group) => group.items.length > 0)
  }, [styleGroups, query])

  const isOpen = (group: FeatureGroup) => {
    if (query.trim()) return true
    return (openGroups ?? DEFAULT_OPEN).has(group.id)
  }
  const toggleOpen = (groupId: string, next: boolean) => {
    setOpenGroups((current) => {
      const base = new Set(current ?? DEFAULT_OPEN)
      if (next) base.add(groupId)
      else base.delete(groupId)
      return base
    })
  }

  const reasonRef = useRef<HTMLInputElement>(null)
  const reasonError = error === '変更理由を入力してください' ? error : ''
  const focusReason = () => {
    reasonRef.current?.focus()
    reasonRef.current?.scrollIntoView({ block: 'center' })
  }
  useEffect(() => { if (reasonError) focusReason() }, [reasonError])
  const validateReason = () => {
    if (reason.trim()) return true
    setError('変更理由を入力してください')
    focusReason()
    return false
  }

  const ready = Boolean(selectedAccountId) && !loading && !loadFailed

  /*
   * ★V8 ：ほかの人が先に保存した。題の下に帯を出し、編集中身は残す。
   * 保存は下の帯から押すので、そのままだと帯が画面の外に出る。帯が出たら板のいちばん上へ戻して見せる。
   */
  const conflictRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!conflicted) return
    const band = conflictRef.current
    if (!band) return
    const scrolled: HTMLElement[] = []
    for (let node = band.parentElement; node; node = node.parentElement) scrolled.push(node)
    band.closest<HTMLElement>('[data-page-template]')?.querySelectorAll<HTMLElement>('[data-template-region]').forEach((node) => scrolled.push(node))
    for (const node of scrolled) if (node.scrollTop > 0) node.scrollTo({ top: 0 })
  }, [conflicted])
  const conflictBand = conflicted ? (
    <div ref={conflictRef} role="status" data-design-node="ziYCN">
      <SaveConflictBand title="ほかの人が先に機能設定を保存しました" onCompare={() => { if (canManage) setCompareOpen(true) }} onReload={() => void load()} />
    </div>
  ) : null

  return (
    <SbSettingsScreen
      boardId="ywFJT"
      notice={conflictBand || (staffRole !== null && !canManage) ? <>{conflictBand}{!canManage && <ReadOnlyNotice role="status" need="manager" />}</> : undefined}
      title={TITLE}
      help={DESCRIPTION}
      explanation={canManage ? `公開中のページや動いている配信・予約は、それぞれの画面で止めてからオフにしてください。並び順は「並びを変える」から入れ替えます。${accountStyle.data?.style === 'restaurant' ? '星を選ぶと左メニューのお気に入りに表示します。' : ''}` : '機能ごとの設定を確認できます。'}
      saveActions={ready && (dirty || saving) ? (
        <>
          <Button
            variant="secondary"
            onClick={discardChanges}
            disabled={saving || !dirty}
            title={!dirty ? '変更すると取り消せます' : undefined}
          >
            キャンセル
          </Button>
          <Button
            variant="primary"
            lockedReason={permissionReason}
            onClick={() => { if (!canManage || !validateReason()) return; if (conflicted) setCompareOpen(true); else void save() }}
            disabled={saving || !dirty || !canManage}
            busy={saving}

            doneLabel="保存しました"
            title={!dirty ? '変更すると保存できます' : undefined}
          >
            {conflicted ? <GitCompare className={styles.btnIcon} aria-hidden="true" /> : <Save className={styles.btnIcon} aria-hidden="true" />}
            {conflicted ? '比べてから保存' : '機能設定を保存'}
          </Button>
        </>
      ) : undefined}

    >
      {!selectedAccountId ? (
        <p className={styles.stateBox}>先に上部でLINEアカウントを選んでください。</p>
      ) : loading ? (
        <div className={styles.stateBox} aria-busy="true" aria-label="機能設定を読み込んでいます">
          <DelayedSkeleton
            loading
            skeleton={(
              <div aria-hidden="true" className={styles.skeleton}>
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className={styles.skeletonRow}>
                    <span className={styles.skeletonGrow}><Skeleton height={14} width="45%" /></span>
                    <Skeleton height={20} width={36} />
                  </div>
                ))}
              </div>
            )}
          />
        </div>
      ) : loadFailed ? (
        <ListState
          kind="error"
          title={error || '設定を読み込めませんでした'}
          onRetry={() => void load()}
        />
      ) : (
        <>
          <div aria-live="polite" className={styles.live}>
            {error && !conflicted && !reasonError && <Notice tone="danger" message={error} />}
          </div>

          <div className={styles.toolbar} data-control-row>
            <SearchField aria-label="機能の名前で探す" placeholder="機能の名前で探す" value={query} onChange={setQuery} className={styles.search} />
            <span className={styles.spacer} />
            <Button variant="secondary" lockedReason={permissionReason} onClick={() => { if (canManage) setReorderOpen(true) }} disabled={saving || !canManage}>
                  <ArrowUpDown className={styles.btnIcon} aria-hidden="true" />
                  並びを変える
                </Button>
            <RowMenu appearance="box" label="機能設定のほかの操作" triggerProps={{ disabled: saving || staffRole === null }}
                  items={[{ id: 'reset', label: '初期値に戻す', tone: 'danger', icon: null, disabled: saving || !canManage, lockedReason: permissionReason, onSelect: () => { if (canManage) setResetToDefaultsOpen(true) } }]} />
          </div>

          {usageFailed && (
                  <Notice tone="warn" action={<>
                    <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={() => void loadUsage()}>利用状況を読み直す</Button>
                  </>}>
                    機能の利用状況を読めませんでした。設定の切替はそのまま使えます。
                    {' '}
                  </Notice>
          )}

          {filteredGroups.length === 0 ? (
            <ListState
              kind="empty"
              emptyPreset="filtered"
              title="条件に合うものはありません"
              description="絞り込みや検索を外すと、すべて出ます"
              action={<Button type="button" variant="secondary" onClick={() => setQuery('')}>条件を外す</Button>}
            />
          ) : (
            <div className={styles.cardCol} data-design="機能の一覧">
              {filteredGroups.map((group) => (
                <FeatureGroupCard
                  key={group.id}
                  group={group}
                  features={features}
                  usageByItemId={usageByItemId}
                  usageByFeatureId={usageByFeatureId}
                  usageRetry={() => void loadUsage()}
                  open={isOpen(group)}
                  canManage={canManage}
                  lockedReason={permissionReason}
                  busy={saving}
                  onOpenChange={(next) => toggleOpen(group.id, next)}
                  onItemToggle={toggleItem}
                  onGroupToggle={toggleGroup}
                  favorites={favorites}
                  showFavorites={accountStyle.data?.style === 'restaurant'}
                  onFavoriteToggle={toggleFavorite}
                />
              ))}
            </div>
          )}

          {/* N-444：変更があるときだけ理由の欄を出す。 */}
          {canManage && dirty && (
            <Field label="変更理由（必須）" htmlFor="feature-settings-reason" error={reasonError || undefined} note="空のままでは保存できません。運用状態の更新履歴に残ります。">
              <SaveErrorField names={["reason"]}><TextField
                ref={reasonRef}
                id="feature-settings-reason"
                aria-required="true"
                value={reason}
                onChange={(event) => { setReason(event.target.value); if (reasonError) setError('') }}
                placeholder="例：マイルを使わないのでオフにする"
                maxLength={300}
                disabled={saving}
              /></SaveErrorField>
            </Field>
          )}
        </>
      )}

      <ConfirmDialog
        open={compareOpen}
        title="最新の設定と編集中の違い"
        description="保存済みの値と編集中の値を確認してください。"
        confirmLabel="比べてから保存"
        busy={saving}
        onCancel={() => setCompareOpen(false)}
        error={error || undefined} onSuccess={() => setCompareOpen(false)} onConfirm={() => { if (!canManage || !validateReason()) return; return save() }}
      >
        <ul className={styles.compareList}>
          {Object.keys(features).filter((key) => features[key] !== savedFeatures[key]).map((key) => (
            <li key={key}>{featureLabelByKey.get(key) ?? '追加機能'}：保存済み {savedFeatures[key] ? 'オン' : 'オフ'} → 編集中 {features[key] ? 'オン' : 'オフ'}</li>
          ))}
          {JSON.stringify(savedFavorites) !== JSON.stringify(favorites) && <li>お気に入り：保存済み {savedFavorites.length}件 → 編集中 {favorites.length}件</li>}
        </ul>
        <p className={styles.compareNote}>並び順も、いま編集中の順番で保存します。</p>
      </ConfirmDialog>

      {reorderOpen && (
        <ReorderDialog
          groups={styleGroups}
          initialOrder={itemOrder}
          moveItemInOrder={moveItemInOrder}
          onCancel={() => setReorderOpen(false)}
          onApply={(order) => {
            if (!canManage) return
            const next = { ...order }
            if (!showEcCommerce && order.settings) {
              const original = groups.find((group) => group.id === 'settings')?.items.map((item) => item.id) ?? []
              const index = original.indexOf('ec-commerce')
              if (index !== -1) {
                next.settings = [...order.settings]
                next.settings.splice(Math.min(index, next.settings.length), 0, 'ec-commerce')
              }
            }
            setItemOrder(next)
            setReorderOpen(false)
          }}
        />
      )}

      <ConfirmDialog
        open={resetToDefaultsOpen}
        title="初期値に戻しますか？"
        headerIcon={<RotateCcw aria-hidden="true" />}
        confirmIcon={<RotateCcw aria-hidden="true" />}
        description="機能の表示・並び順・お気に入りを初期値の下書きに置き換えます。保存するまで、他の利用者やサイドメニューには反映されません。"
        confirmLabel="初期値を下書きに入れる"
        cancelLabel="キャンセル"
        onCancel={() => { if (!saving) setResetToDefaultsOpen(false) }}
        onConfirm={() => { if (canManage) resetToDefaults() }}
      >
        <DialogContentRow>機能ごとの表示（オン・オフ）</DialogContentRow>
        <DialogContentRow>メニューの並び順</DialogContentRow>
        <DialogContentRow>お気に入り</DialogContentRow>
      </ConfirmDialog>

      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="この画面で変更した機能の表示・並び順・お気に入り"
        busy={saving}
        onCancel={() => { if (!saving) cancelLeave() }}
        onConfirm={() => {
          setSavedFeatures({ ...features })
          setSavedItemOrder(currentOrder)
          setSavedFavorites([...favorites])
          confirmLeave()
        }}
      />

      <ConfirmDialog
        open={impactOpen && renderedImpactScope?.scope === accountScope.current}
        title="オフにする前に確認"
        description="止まる仕事があります。オフにしてもデータは削除されず、再度オンにすると再開できます。公開中のページや動いている配信・予約は、それぞれの画面で止めてからオフにしてください。"
        confirmLabel="確認して保存する"
        destructive
        confirmIcon={false}
        busy={impactBusy || saving}
        error={impactError || undefined}
        onCancel={() => {
          if (impactBusy || saving || renderedImpactScope?.scope !== accountScope.current || renderedImpactScope !== impactScope.current) return
          impactScope.current = null
          setImpactOpen(false)
          setImpactError('')
        }}
        onConfirm={() => { if (canManage && renderedImpactScope?.scope === accountScope.current && renderedImpactScope === impactScope.current) return confirmImpactSave() }}
      >
        <OperationTargetSummary accounts={[{ id: renderedImpactScope?.id ?? '' }]} />
        <DetailContent><DetailSection><DetailFields><div>
          <dt>止まるもの</dt>
          <dd>{impactGroups.map((group) => (
            <div key={group.feature}>{featureLabelByKey.get(group.feature) ?? group.feature} {impactSummary(group)}</div>
          ))}</dd>
        </div></DetailFields></DetailSection></DetailContent>
      </ConfirmDialog>
    </SbSettingsScreen>
  )
}
