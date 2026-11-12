'use client'

import CloseButton from '@/components/shared/close-button'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { memberRanksApi } from '@/lib/api/helpers/gap3';
import { useOverlayLayer } from '@/components/shared/overlay-utils';
import TagOverflow from '@/components/shared/tag-overflow';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import TagPill from '@/components/shared/tag-pill';
import type { SavedSearchCondition, Scenario, Tag } from '@line-crm/shared';
import { api } from '@/lib/api';
import { conditionsToEditorState, describeSavedCondition, describeSavedVisibility, editorStateToConditions, hasSavedSearchFilter, type FriendSearchBlock, type FriendSearchEditorState, type FriendVisibilityChoice, type SavedSearchConditionLabels } from './saved-search-utils';
import { TextInput } from '@/components/shared/form-controls';
import DateField from '@/components/shared/date-field';
import Button from '@/components/shared/button';
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import Select from '@/components/shared/select';
import HelpTip from '@/components/shared/help-tip';
import { useOverlayFocus } from '@/components/shared/overlay-utils';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { formatNumber } from '@/lib/format';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import { BLOCK_HELP, type AdvancedSearchResult } from './advanced-search-dialog-gap-parts'
import { TextField as SharedTextField } from '@/components/shared/text-field'
export type { AdvancedSearchResult } from './advanced-search-dialog-gap-parts'
/**
 * V4の詳細検索。既存APIが受け取れる条件だけを実行対象にする。
 *
 * これまで「詳細検索」は押せないボタンだった。条件を組み立てて渡す口が
 * 無かったため。`/api/friends` に足し算の絞り込みを入れたので、
 * **受け口のあるものだけ**を組み立てられるようにする。
 *
 * 受け口が無い条件は、押せない札として並べて理由を出す。隠すと
 * 「作り忘れ」に見えるし、押せるようにすると黙って無視される。
 */

/** 絞り込みの1ブロック。設計の「条件」1つぶん。 */
type Block = FriendSearchBlock
const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50] as const

const BLOCK_LABEL: Record<Block['kind'], string> = {
  name: '名前',
  tag: 'タグ',
  field: '友だち情報',
  status_message: 'ステータスメッセージ',
  created_at: '友だち登録日',
  chat_status: '対応状況',
  visit_count: '来店の回数',
  purchase_amount: '購入の合計金額',
  last_activity_at: '最後の来店・購入の日',
  member_tier: '会員ランク',
}





const VISIBILITY_OPTIONS: Array<{ value: FriendVisibilityChoice; label: string }> = [
  { value: 'visible', label: '表示中' },
  { value: 'hidden', label: '非表示のみ' },
  { value: 'blocked', label: 'ブロックした人' },
  { value: 'all', label: 'すべて' },
]



function defaultBlocks(fieldsEnabled: boolean): Block[] {
  const blocks: Block[] = [
    { kind: 'name', keyword: '' },
    { kind: 'tag', include: [], exclude: [] },
  ]
  if (fieldsEnabled) blocks.push({ kind: 'field', key: '', op: 'eq', value: '' })
  return blocks
}

export default function AdvancedSearchDialog({
  open,
  accountId,
  tags,
  fieldNames,
  marks,
  scenarios,
  onClose,
  onLoadSaved,
  onApply,
  features,
  applied,
  initialSort,
  initialLimit,
}: {
  open: boolean
  accountId: string | null
  tags: Tag[]
  /** 友だち情報の項目名。取れないときは空でよい（自由入力にする）。 */
  fieldNames: string[]
  marks: Array<{ id: string; name: string }>
  scenarios: Scenario[]
  onClose: () => void
  onLoadSaved?: () => void
  onApply: (result: AdvancedSearchResult) => void
  /** 機能設定でオフの入口は出さない。未指定は従来どおり全部出す。 */
  features?: { savedSearch?: boolean; marks?: boolean; fields?: boolean }
  /**
   * 現在適用中の条件。開いたときこの編集状態から再開する。
   * 保存した検索の適用後は、保存された実条件を復元した状態が入る。
   */
  applied?: AdvancedSearchResult | null
  /** 一覧の現在の並び順・表示件数。開いたときの初期値にする。 */
  initialSort: 'recent' | 'oldest'
  initialLimit: number
}) {
  const saveErrors = useSaveFormErrors()

  const savedSearchEnabled = features?.savedSearch !== false
  const marksFeatureEnabled = features?.marks !== false
  const fieldsFeatureEnabled = features?.fields !== false
  const [blocks, setBlocks] = useState<Block[]>(() => defaultBlocks(fieldsFeatureEnabled))
  /* ★V8 ：会員ランクの段の候補。ランクを動かしていない店では空。 */
  const [rankTiers, setRankTiers] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!open || !accountId) return
    let alive = true
    memberRanksApi.program(accountId).then((r) => { if (alive && r.success) setRankTiers(r.data.tiers.map((t) => ({ id: t.id, name: t.name }))) }).catch(() => undefined)
    return () => { alive = false }
  }, [open, accountId])
  /* 共通の重なり番号：この窓の上に開く窓（準備中など）が後ろに回らない。 */
  const layer = useOverlayLayer(open)
  const [visibility, setVisibility] = useState<FriendVisibilityChoice>('visible')
  const [any, setAny] = useState<SavedSearchCondition[]>([])
  const [extraAll, setExtraAll] = useState<SavedSearchCondition[]>([])
  const [sort, setSort] = useState<'recent' | 'oldest'>(initialSort)
  const [limit, setLimit] = useState<number>(initialLimit)
  const [count, setCount] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  const [countFailed, setCountFailed] = useState(false)
  const countRequestRef = useRef(0)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedNotice, setSavedNotice] = useState('')
  const conditionBaseline = useRef<string | null>(null)
  const conditionSnapshot = JSON.stringify([blocks, any, extraAll, visibility, sort, limit])
  const guard = useUnsavedGuard({ dirty: open && (saveName.trim() !== '' || (conditionBaseline.current !== null && conditionSnapshot !== conditionBaseline.current)), busy: open && saving, subject: '検索条件への変更', onDiscard: () => { setSaveName(''); setSaveOpen(false) } })
  const requestClose = () => guard.guarded(onClose)
  /*
    FRIEND-13: 共通ダイアログと同じ約束（role=dialog・aria-modal・
    開いたら窓の中へフォーカス・Tabは窓の中で回る・Escapeで閉じる・
    閉じたら起点へフォーカスを戻す・背面はスクロールしない）を
    useOverlayFocus でそろえる。
    「条件を保存」の入れ子窓が開いている間は外側を閉じない。
    Escapeは最上位（入れ子）だけに効かせるため、外側の閉じる処理は
    saveOpen を見て何もしない。hook の依存にすると効果の掛け直しで
    フォーカスが起点へ飛ぶので、ref 越しに見る。
  */
  const dialogTitleId = useId()
  const saveTitleId = useId()
  const saveOpenRef = useRef(saveOpen)
  saveOpenRef.current = saveOpen
  const panelRef = useOverlayFocus(open, () => {
    if (!saveOpenRef.current) requestClose()
  })
  const savePanelRef = useOverlayFocus(saveOpen, () => setSaveOpen(false), saving)

  /** IDや内部名を画面へ出さないための、ID→表示名の辞書。 */
  const labels = useMemo<SavedSearchConditionLabels>(() => ({
    marks: Object.fromEntries(marks.map((mark) => [mark.id, mark.name])),
    scenarios: Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario.name])),
  }), [marks, scenarios])

  const editorState = useMemo<FriendSearchEditorState>(
    () => ({ blocks, any, extraAll, visibility }),
    [blocks, any, extraAll, visibility],
  )

  /*
   * FRIEND-32: 開くたびに「今適用されている条件」から再開する。
   * 保存した検索の適用直後に開いても、保存条件がブロックへ復元される。
   * 開いている途中で props が変わっても入力中の状態を捨てないよう、
   * 閉→開の切り替わりの時だけ初期化する。
   */
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const state = applied?.editorState
      const initialBlocks = state?.blocks ?? defaultBlocks(fieldsFeatureEnabled)
      const initialAny = state?.any ?? []
      const initialExtraAll = state?.extraAll ?? []
      const initialVisibility = state?.visibility ?? 'visible'
      const safeLimit = PAGE_SIZE_OPTIONS.includes(initialLimit as (typeof PAGE_SIZE_OPTIONS)[number]) ? initialLimit : 20
      conditionBaseline.current = JSON.stringify([initialBlocks, initialAny, initialExtraAll, initialVisibility, initialSort, safeLimit])
      setBlocks(initialBlocks)
      setAny(initialAny)
      setExtraAll(initialExtraAll)
      setVisibility(initialVisibility)
      setSort(initialSort)
      setLimit(safeLimit)
      setSavedNotice('')
      setCountFailed(false)
    }
    wasOpenRef.current = open
  }, [open, applied, fieldsFeatureEnabled, initialSort, initialLimit])

  /*
   * ?savedSearch= の直URLなど、IDだけ分かって実条件が手元に無い適用は、
   * 開いたときに保存済み一覧から同じIDの条件を引いて復元する。
   * 見つからなければ空の編集画面のままにし、黙って別条件にしない。
   */
  useEffect(() => {
    const savedId = applied?.params.savedSearchId
    if (!open || !savedId || applied?.editorState || !accountId || !savedSearchEnabled) return
    let cancelled = false
    void api.friendSavedViews.list(accountId, { suppressFeatureDisabledEvent: true }).then((res) => {
      if (cancelled || !res.success) return
      const found = res.data.items.find((view) => view.id === savedId)
      if (!found) return
      const state = conditionsToEditorState(found.conditions)
      conditionBaseline.current = JSON.stringify([state.blocks, state.any, state.extraAll, state.visibility, initialSort, PAGE_SIZE_OPTIONS.includes(initialLimit as (typeof PAGE_SIZE_OPTIONS)[number]) ? initialLimit : 20])
      setBlocks(state.blocks)
      setAny(state.any)
      setExtraAll(state.extraAll)
      setVisibility(state.visibility)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, applied, accountId, savedSearchEnabled, initialSort, initialLimit])

  const params = useMemo<AdvancedSearchResult['params']>(() => {
    /*
     * FRIEND-32: 保存した検索から開いて何も変えずに適用し直すときは、
     * savedSearchId をそのまま残す。条件の中身とIDの同時送信は受け口が
     * 拒否する。平たい引数も混ぜない —— ?search= は並び順を検索順位へ
     * 切り替えるので、保存検索の「新しい順/古い順」と食い違う。
     */
    const appliedSavedId = applied?.params.savedSearchId
    if (appliedSavedId
        && applied?.editorState !== undefined
        && JSON.stringify(editorState) === JSON.stringify(applied.editorState)) {
      return { savedSearchId: appliedSavedId, sort, limit }
    }
    const p: AdvancedSearchResult['params'] = { sort, limit }
    /*
     * 対象は2軸ある。一覧の ?visibility= は is_following（友だち中/ブロック）、
     * conditions.visibility は is_hidden（表示中/非表示）。1つの選択から
     * 両方へ意味の通る値だけを出す（FRIEND-01）。
     */
    if (visibility === 'visible') p.visibility = 'following'
    else if (visibility === 'blocked') p.visibility = 'blocked'
    for (const b of blocks) {
      if (b.kind === 'name' && b.keyword.trim()) p.search = b.keyword.trim()
      if (b.kind === 'tag') {
        if (b.include.length) p.tagIds = b.include
        if (b.exclude.length) p.excludeTagIds = b.exclude
      }
      if (b.kind === 'field' && fieldsFeatureEnabled && b.key.trim() && b.value.trim()) {
        const bag = b.op === 'eq' ? (p.metadata ??= {}) : (p.metadataNot ??= {})
        bag[b.key.trim()] = b.value.trim()
      }
      if (b.kind === 'status_message' && b.keyword.trim()) p.statusMessage = b.keyword.trim()
      if (b.kind === 'created_at') {
        if (b.from) p.createdFrom = b.from
        if (b.to) p.createdTo = b.to
      }
      if (b.kind === 'chat_status') p.chatStatus = b.value
    }
    /*
     * FRIEND-02: 同じ項目の条件が複数あっても全て残す。
     * 上の平たい引数（search 等）は1つしか入らない旧い受け口なので、
     * 実際の絞り込みは conditions が正本。画面・保存・件数は全部これを使う。
     *
     * FRIEND-01: 「すべて」で条件も無いときは conditions 自体を送らない。
     * 空の条件は受け口が弾くので、送らないことが「全員を見る」の正しい形。
     */
    const conditions = editorStateToConditions(editorState, { sort, limit })
    if (hasSavedSearchFilter(conditions)) {
      p.conditions = conditions
    }
    return p
  }, [blocks, editorState, visibility, sort, limit, fieldsFeatureEnabled, applied])

  const summary = useMemo(() => {
    const out: string[] = []
    /*
     * 対象（表示中/非表示/すべて）は常に見せる。条件と件数が食い違わないように。
     * 保存検索の無変更再適用では params が savedSearchId だけになるので、
     * params ではなく編集状態から説明を作る（FRIEND-32）。
     */
    out.push(`対象：${describeSavedVisibility(editorStateToConditions(editorState, { sort, limit }))}`)
    for (const b of blocks) {
      if (b.kind === 'name' && b.keyword.trim()) out.push(`名前に「${b.keyword.trim()}」`)
      if (b.kind === 'tag') {
        if (b.include.length) {
          out.push(`タグ ${b.include.map((id) => tags.find((t) => t.id === id)?.name ?? id).join('・')}`)
        }
        if (b.exclude.length) {
          out.push(`タグ以外 ${b.exclude.map((id) => tags.find((t) => t.id === id)?.name ?? id).join('・')}`)
        }
      }
      if (b.kind === 'field' && b.key.trim() && b.value.trim()) {
        out.push(`${b.key.trim()} が ${b.value.trim()}${b.op === 'ne' ? ' 以外' : ''}`)
      }
      if (b.kind === 'status_message' && b.keyword.trim()) out.push(`ひとこと「${b.keyword.trim()}」`)
      if (b.kind === 'created_at' && (b.from || b.to)) {
        out.push(`登録日 ${b.from || '…'} 〜 ${b.to || '…'}`)
      }
      if ((b.kind === 'visit_count' || b.kind === 'purchase_amount') && (b.min || b.max)) out.push(`${BLOCK_LABEL[b.kind]} ${b.min || '…'} 〜 ${b.max || '…'}`)
      if (b.kind === 'last_activity_at' && (b.from || b.to)) out.push(`最後の来店・購入 ${b.from || '…'} 〜 ${b.to || '…'}`)
      if (b.kind === 'member_tier' && b.tierId) out.push(`会員ランク ${rankTiers.find((t) => t.id === b.tierId)?.name ?? '選択済み'}`)
      if (b.kind === 'chat_status') {
        out.push(
          `対応状況 ${{ unread: '未対応', in_progress: '対応中', on_hold: '保留', resolved: '対応済み' }[b.value]}`,
        )
      }
    }
    for (const condition of extraAll) out.push(describeSavedCondition(condition, tags, labels))
    for (const condition of any) out.push(`OR: ${describeSavedCondition(condition, tags, labels)}`)
    return out
  }, [blocks, extraAll, any, tags, labels, editorState, sort, limit])

  /** 該当件数。押す前に何人になるかが分からないと、条件を組み立てられない。 */
  const recount = useCallback(async () => {
    /*
     * A03-02: 応答の世代を照合する。条件A→Bと素早く変えてAの応答が
     * 後から届いても、Bの件数をAで上書きしない。失敗は0件扱いせず
     * 「確認できません」と再試行を出す。
     */
    const requestId = ++countRequestRef.current
    setCounting(true)
    setCountFailed(false)
    try {
      // 件数だけ欲しいので1件だけ取る。total は絞り込み後の総数が返る。
      const res = await api.friends.list({ ...params, accountId: accountId ?? undefined, limit: 1, includeTags: false })
      if (requestId !== countRequestRef.current) return
      setCount(res.success ? res.data.total : null)
      setCountFailed(!res.success)
    } catch (saveFailure) {
      if (requestId !== countRequestRef.current) return
      saveErrors.capture(saveFailure)
      setCount(null)
      setCountFailed(true)
    } finally {
      if (requestId === countRequestRef.current) setCounting(false)
    }
  }, [accountId, params, saveErrors])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void recount(), 400)
    return () => window.clearTimeout(timer)
  }, [open, recount])

  if (!open) return null

  const patch = (i: number, next: Block) =>
    setBlocks((prev) => prev.map((b, j) => (j === i ? next : b)))
  const drop = (i: number) => setBlocks((prev) => prev.filter((_, j) => j !== i))
  const add = (kind: Block['kind']) =>
    setBlocks((prev) => [
      ...prev,
      kind === 'name'
        ? { kind: 'name', keyword: '' }
        : kind === 'tag'
          ? { kind: 'tag', include: [], exclude: [] }
          : kind === 'field'
            ? { kind: 'field', key: '', op: 'eq', value: '' }
            : kind === 'status_message'
              ? { kind: 'status_message', keyword: '' }
              : kind === 'created_at'
                ? { kind: 'created_at', from: '', to: '' }
                : kind === 'visit_count' || kind === 'purchase_amount'
                  ? { kind, min: '', max: '' }
                  : kind === 'last_activity_at'
                    ? { kind: 'last_activity_at', from: '', to: '' }
                    : kind === 'member_tier'
                      ? { kind: 'member_tier', tierId: '' }
                      : { kind: 'chat_status', value: 'unread' },
    ])

  const resetConditions = () => {
    /* FRIEND-01: リセットは初期状態（表示中・空の条件）へ戻す。 */
    setBlocks(defaultBlocks(fieldsFeatureEnabled))
    setAny([])
    setExtraAll([])
    setVisibility('visible')
  }

  const save = async () => {
    if (!accountId) {
      setSaveError('LINE公式アカウントを選んでください')
      return
    }
    if (!saveName.trim()) {
      setSaveError('条件名を入力してください')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      /*
       * 保存は編集状態から直接 conditions を組み立てる。
       * 平たい引数へのフォールバックは「すべて」を visible_only へ
       * 書き換えてしまうので使わない（FRIEND-01/32）。
       */
      const res = await api.friendSavedViews.create(accountId, {
        name: saveName.trim(),
        conditions: editorStateToConditions(editorState, { sort, limit }),
        isShared: false,
      })
      if (!res.success) {
        setSaveError(res.error)
        return
      }
      guard.disarm()
      setSaveName('')
      setSaveOpen(false)
      setSavedNotice('条件を保存しました')
    } catch (error) {
      const fieldFailure = saveErrors.capture(error)

      { if (!fieldFailure) setSaveError(describeApiFailure(error, '保存')) }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><><div
      className="fixed inset-0 flex items-center justify-center bg-scrim p-4"
      style={{ zIndex: layer }}
      data-design-node="CYJ0L"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        tabIndex={-1}
        /*
         * @container: パネル自身をコンテナにする。中の条件ブロックの
         * 組み換え（項目・比較方法・値の縦3段化）は、画面の幅ではなく
         * このパネルの幅で切り替える（#984 U011再）。
         */
        className="@container flex max-h-[calc(100vh-32px)] w-full max-w-200 flex-col overflow-hidden rounded-panel border border-hairline bg-canvas shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-divider-soft px-6 py-5">
          <div>
            <h2 id={dialogTitleId} className="text-ink text-lg font-bold">絞り込み条件を設定</h2>
            <p className="text-ink-secondary mt-0.5 text-xs">
              条件を足すたびに人数を数え直します
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onLoadSaved && savedSearchEnabled ? (
              <Button type="button" onClick={() => guard.guarded(onLoadSaved)}>
                保存した検索から読み込む
              </Button>
            ) : null}
            <CloseButton onClick={requestClose} />
          </div>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto px-6 py-4">
          <section className="rounded-panel border border-accent-border bg-accent-soft px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-micro font-medium text-ink-faint">現在の条件に一致</p>
                <p className="mt-0.5 text-xl font-bold tabular-nums text-ink">
                  {counting ? '…' : count === null ? '—' : `${formatNumber(count)}人`}
                </p>
              </div>
              {countFailed ? (
                <span className="flex items-center gap-2 text-micro text-ink-secondary">
                  件数を確認できません
                  <button
                    type="button"
                    onClick={() => void recount()}
                    className="font-semibold text-action underline"
                  >
                    再試行
                  </button>
                </span>
              ) : (
                <span className="text-micro text-ink-faint">自動で再計算</span>
              )}
            </div>
          </section>

          <section className="rounded-card border content-card bg-canvas p-3">
          <div className="flex items-center gap-2 px-1 pb-2">
            <span className="bg-surface-pearl text-ink-secondary rounded-pill px-2 py-0.5 text-xs font-medium">
              すべて
            </span>
            <span className="text-ink text-sm font-bold">すべて満たす条件</span>
          </div>

          {/* 友だち情報欄がオフのaccountでは、初期配置の field ブロックも出さない。 */}
          {blocks.map((b, i) => (b.kind === 'field' && !fieldsFeatureEnabled ? null : (
            <section
              key={`${b.kind}-${i}`}
              className="mb-2 grid items-center gap-3 rounded-card bg-canvas-sunken p-3 last:mb-0 sm:grid-cols-12"
            >
              <div className="sm:col-span-3">
                <h3 className="flex items-center text-sm font-semibold text-ink">{BLOCK_LABEL[b.kind]}<HelpTip label={`${BLOCK_LABEL[b.kind]}の説明`}>{BLOCK_HELP[b.kind]}</HelpTip></h3>
              </div>

              <div className="min-w-0 sm:col-span-8">
                {b.kind === 'name' && (
                  <SaveErrorField names={[`blocks.${i}.keyword`,"keyword","b.keyword"]}><TextInput
                    value={b.keyword}
                    onChange={(e) => patch(i, { ...b, keyword: e.target.value })}
                    placeholder="キーワードを入力"
                    aria-label="名前のキーワード"
                  /></SaveErrorField>
                )}

                {b.kind === 'tag' && (
                  <TagPicker
                    tags={tags}
                    include={b.include}
                    exclude={b.exclude}
                    onChange={(include, exclude) => patch(i, { ...b, include, exclude })}
                  />
                )}

                {b.kind === 'field' && (
                  /*
                   * #976 U087: 欄名・比較方法・値に常設ラベルを置く。
                   * placeholder だけだと、入力したあと「何の欄か」が残らない。
                   *
                   * #984 U011再: パネル幅が @3xl(768px) 未満では縦3段にして
                   * 各入力を全幅にする。画面幅ではなくパネル自身の幅で切り替える
                   * （パネルは直近の @container）。画面幅の sm: だと、狭い
                   * パネルの中で3列に押し込まれて1〜2文字しか見えなかった。
                   */
                  <div className="flex flex-col items-stretch gap-2 @3xl:flex-row @3xl:items-end">
                    <label className="min-w-0 @3xl:flex-1">
                      <span className="text-caption mb-1 block font-semibold text-ink-secondary">項目</span>
                      <SaveErrorField names={[`blocks.${i}.key`,"key","b.key"]}><TextInput
                        list="friend-field-names"
                        value={b.key}
                        onChange={(e) => patch(i, { ...b, key: e.target.value })}
                        placeholder="例：誕生日"
                      /></SaveErrorField>
                    </label>
                    <datalist id="friend-field-names">
                      {fieldNames.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                    <label className="@3xl:shrink-0">
                      <span className="text-caption mb-1 block font-semibold text-ink-secondary">比較方法</span>
                      <SaveErrorField names={[`blocks.${i}.op`,"op","b.op"]}><Select
                        aria-label="比較方法"
                        value={b.op}
                        onChange={(value) => patch(i, { ...b, op: value as 'eq' | 'ne' })}
                        options={[
                          { value: 'eq', label: '等しい' },
                          { value: 'ne', label: '等しくない' },
                        ]}
                      /></SaveErrorField>
                    </label>
                    <label className="min-w-0 @3xl:flex-1">
                      <span className="text-caption mb-1 block font-semibold text-ink-secondary">値</span>
                      <SaveErrorField names={[`blocks.${i}.value`,"value","b.value"]}><TextInput
                        value={b.value}
                        onChange={(e) => patch(i, { ...b, value: e.target.value })}
                        placeholder="例：1990-01-01"
                      /></SaveErrorField>
                    </label>
                  </div>
                )}

                {b.kind === 'status_message' && (
                  <SaveErrorField names={[`blocks.${i}.keyword`,"keyword","b.keyword"]}><TextInput
                    value={b.keyword}
                    onChange={(e) => patch(i, { ...b, keyword: e.target.value })}
                    placeholder="ひとことに含む文字"
                    aria-label="ひとことに含む文字"
                  /></SaveErrorField>
                )}

                {b.kind === 'created_at' && (
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SaveErrorField names={[`blocks.${i}.from`,"from","b.from"]}><DateField
                        value={b.from}
                        onChange={(v) => patch(i, { ...b, from: v })}
                        aria-label="友だち登録日の開始"
                      /></SaveErrorField>
                      <span className="text-ink-secondary text-sm">〜</span>
                      <SaveErrorField names={[`blocks.${i}.to`,"to","b.to"]}><DateField
                        value={b.to}
                        onChange={(v) => patch(i, { ...b, to: v })}
                        aria-label="友だち登録日の終了"
                      /></SaveErrorField>
                    </div>
                    {/* R183: 逆転期間は保存・実行のどちらも断られる。欄で先に知らせる。 */}
                    {b.from && b.to && b.from > b.to ? (
                      <p role="alert" className="mt-1 text-xs text-danger">開始日が終了日より後になっています。入れ替えると保存できます。</p>
                    ) : null}
                  </div>
                )}

                {(b.kind === 'visit_count' || b.kind === 'purchase_amount') && (
                  <div className="flex flex-wrap items-center gap-2">
                    <TextInput className="w-36" type="number" min={0} value={b.min} onChange={(e) => patch(i, { ...b, min: e.target.value })} placeholder="下限なし" aria-label={`${BLOCK_LABEL[b.kind]}の下限`} />
                    <span className="text-ink-faint text-sm">{b.kind === 'visit_count' ? '回以上〜' : '円以上〜'}</span>
                    <TextInput className="w-36" type="number" min={0} value={b.max} onChange={(e) => patch(i, { ...b, max: e.target.value })} placeholder="上限なし" aria-label={`${BLOCK_LABEL[b.kind]}の上限`} />
                    <span className="text-ink-faint text-sm">{b.kind === 'visit_count' ? '回以下' : '円以下'}</span>
                  </div>
                )}
                {b.kind === 'last_activity_at' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <DateField value={b.from} onChange={(next) => patch(i, { ...b, from: next })} aria-label="最後の来店・購入の日の開始" className="w-48" />
                    <span className="text-ink-faint text-sm">〜</span>
                    <DateField value={b.to} onChange={(next) => patch(i, { ...b, to: next })} aria-label="最後の来店・購入の日の終了" className="w-48" />
                  </div>
                )}
                {b.kind === 'member_tier' && (
                  <EntitySelect aria-label="会員ランク" value={b.tierId} onChange={(value) => patch(i, { ...b, tierId: value })} options={[{ value: '', label: 'ランクを選ぶ' }, ...rankTiers.map((t) => ({ value: t.id, label: `${t.name}の人` }))]} />
                )}
                {b.kind === 'chat_status' && (
                  <>
                    {/* FRIEND-05: 説明どおり固定4状態。保留も検索できる。 */}
                    <SaveErrorField names={[`blocks.${i}.value`,"value","b.value"]}><Select
                      aria-label="対応状況"
                      value={b.value}
                      onChange={(value) =>
                        patch(i, { ...b, value: value as 'unread' | 'in_progress' | 'on_hold' | 'resolved' })
                      }
                      options={[
                        { value: 'unread', label: '未対応' },
                        { value: 'in_progress', label: '対応中' },
                        { value: 'on_hold', label: '保留' },
                        { value: 'resolved', label: '対応済み' },
                      ]}
                    /></SaveErrorField>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={() => drop(i)}
                aria-label={`${BLOCK_LABEL[b.kind]}の条件を外す`}
                className="text-danger text-xs hover:underline"
              >
                外す
              </button>
            </section>
          )))}

          <div className="mt-2 flex flex-wrap gap-2 px-1 pt-1">
              {(Object.keys(BLOCK_LABEL) as Block['kind'][]).filter((k) => k !== 'field' || fieldsFeatureEnabled).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => add(k)}
                  className="text-action rounded-control px-1 py-1 text-xs font-semibold hover:bg-action-soft"
                >
                  ＋ {BLOCK_LABEL[k]}
                </button>
              ))}
          </div>

          {/* 編集画面で組み直せない保存済み条件。黙って落とさず外せる形で残す（FRIEND-32）。 */}
          {extraAll.length > 0 ? (
            <div className="mt-2 space-y-2 px-1">
              <p className="text-nano text-ink-faint">保存されていたその他の条件</p>
              {extraAll.map((condition, index) => (
                <div key={`extra-${index}`} className="flex items-center justify-between rounded-control bg-canvas-sunken px-3 py-2 text-xs text-ink-secondary">
                  <span>{describeSavedCondition(condition, tags, labels)}</span>
                  <button
                    type="button"
                    onClick={() => setExtraAll((current) => current.filter((_, i) => i !== index))}
                  >
                    外す
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          </section>

          <section className="rounded-panel border border-hairline bg-canvas p-3">
            <div className="flex items-center gap-2">
              <span className="rounded-pill bg-surface-pearl px-2 py-0.5 text-xs font-medium text-ink-secondary">どれか</span>
              <span className="text-sm font-bold text-ink">いずれか1つ以上満たす条件</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              {OR_AXES.filter((item) => item.feature !== 'support_marks' || marksFeatureEnabled).map((item) => (
                <OrAxisPicker
                  key={item.label}
                  axis={item}
                  marks={marks}
                  scenarios={scenarios}
                  onAdd={(condition) => setAny((current) => [...current, condition])}
                />
              ))}
            </div>
            {any.length > 0 ? (
              <div className="mt-3 space-y-2">
                {/* FRIEND-03: 条件チップは実際の名前・日付を表示する。 */}
                {any.map((condition, index) => (
                  <div key={`${index}-${condition.kind}`} className="flex items-center justify-between rounded-control bg-action-soft px-3 py-2 text-xs text-action">
                    <span>{describeSavedCondition(condition, tags, labels)}</span>
                    <button type="button" onClick={() => setAny((current) => current.filter((_, itemIndex) => itemIndex !== index))}>外す</button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="rounded-panel border border-hairline bg-canvas p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-bold text-ink">表示する友だち</span>
              <span className="text-nano text-ink-faint">既定は「表示中」のみ</span>
            </div>
            {/*
              FRIEND-01: 対象は1か所で選ぶ。以前はチェックボックスと
              「対象」プルダウンの2か所が同じ変数へ別の意味で書き込み、
              「すべて」が非表示だけを検索していた。
            */}
            <SaveErrorField names={["friend-search-visibility","value","item.value","visibility"]}><RadioCardGroup legend="表示する友だち" className="mt-2 flex flex-wrap gap-4">
              {VISIBILITY_OPTIONS.map((item) => (
                <RadioCard
                  key={item.value}
                  name="friend-search-visibility"
                  value={item.value}
                  checked={visibility === item.value}
                  onChange={() => setVisibility(item.value)}
                  title={item.label}
                />
              ))}
            </RadioCardGroup></SaveErrorField>
            <label className="mt-3 flex flex-wrap items-center gap-3 text-xs font-semibold text-ink-secondary">
              友だちの状態
              {/* 共通Selectはvalue/onChange必須のため、操作なしの固定表示として値と空の変更受けを付ける。disabledの見た目・文言は変えない。 */}
              <Select
                aria-label="友だちの状態"
                value=""
                onChange={() => {}}
                options={[{ value: '', label: 'このアカウントをブロックしていない' }]}
                disabled
              />
              <span className="text-nano font-medium text-ink-faint">相手側のブロック状態を絞る口の接続後に選べます</span>
            </label>
          </section>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="rounded-card border content-card bg-canvas px-3 py-2">
              <span className="text-nano text-ink-faint">並び順</span>
                <SaveErrorField names={["sort"]}><Select
                  aria-label="並び順"
                  value={sort}
                  onChange={(value) => setSort(value as 'recent' | 'oldest')}
                  options={[
                    { value: 'recent', label: '友だち追加の新しい順' },
                    { value: 'oldest', label: '友だち追加の古い順' },
                  ]}
                  size="full"
                  className="mt-0.5"
                /></SaveErrorField>
            </label>
            {/* FRIEND-04: 表示件数も条件の一部として適用する。 */}
            <label className="rounded-card border content-card bg-canvas px-3 py-2">
              <span className="text-nano text-ink-faint">表示件数</span>
              <SaveErrorField names={["limit"]}><Select
                aria-label="表示件数"
                value={String(limit)}
                onChange={(value) => setLimit(Number(value))}
                options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `${size}件` }))}
                size="page-size"
                className="mt-0.5"
              /></SaveErrorField>
            </label>
          </div>
        </div>

        {/*
          U013: 補助操作（読み込む・リセット・保存）は上段、確定操作
          （キャンセル・この条件で表示）は下段の右へ固定する。
          1行に混ぜると狭い幅で確定操作の位置が行によって変わり、
          何を押せば確定かが読めなかった。
        */}
        <div className="border-t border-divider-soft px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={resetConditions}
              className="text-xs font-medium text-ink-faint hover:text-ink-secondary"
            >
              条件をリセット
            </button>
            {savedNotice ? <span className="text-xs font-semibold text-accent-deep">{savedNotice}</span> : null}
            {savedSearchEnabled ? (
              <Button type="button" onClick={() => { setSaveOpen(true); setSaveError(''); setSavedNotice('') }}>条件を保存する</Button>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            <Button type="button" onClick={requestClose}>
              キャンセル
            </Button>
            {/* #976 U084: 主操作は共通Buttonの primary（`$accent-deep` + 白文字）。 */}
            <Button
              type="button"
              variant="primary"
              className="px-5"
              onClick={() => { const apply = () => onApply({ params, summary, editorState }); if (saveName.trim()) guard.guarded(apply); else apply() }} busy={counting} busyLabel="再計算中…">
              {count === null ? 'この条件で表示' : `${formatNumber(count)}人を表示`}
            </Button>
          </div>
        </div>
      </div>
      {saveOpen ? (
        <div className="fixed inset-0 z-110 flex items-center justify-center bg-scrim p-4" onClick={() => setSaveOpen(false)}>
          {/* FRIEND-13: 入れ子窓にも同じ約束。Escapeでこの窓だけ閉じる。 */}
          <section
            ref={savePanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={saveTitleId}
            tabIndex={-1}
            className="w-full max-w-md rounded-panel border border-hairline bg-canvas p-5 shadow-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 id={saveTitleId} className="text-lg font-bold text-ink">この条件を保存</h3>
              <button type="button" onClick={() => setSaveOpen(false)} disabled={saving} aria-label="閉じる" className="rounded-mini p-1 text-ink-secondary hover:bg-canvas-sunken">
                <X aria-hidden="true" className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-xs leading-5 text-ink-faint">保存後は「保存した検索」から何度でも呼び出せます。</p>
            <label className="mt-4 block text-sm font-semibold text-ink-secondary">
              条件名
              <SaveErrorField names={["saveName","name","save_name"]}><TextInput autoFocus value={saveName} onChange={(event) => setSaveName(event.target.value)} maxLength={80} placeholder="例：VIPかつ未契約" className="mt-2" /></SaveErrorField>
            </label>
            {saveError ? <p className="mt-3 text-sm text-danger">{saveError}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" onClick={() => setSaveOpen(false)}>キャンセル</Button>
              <Button type="button" variant="primary" disabled={saving} onClick={() => void save()} busy={saving}>保存する</Button>
            </div>
          </section>
        </div>
      ) : null}
    </div><UnsavedLeaveDialog subject="検索条件への変更" open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></></SaveErrorScope>
  )
}

function TagPicker({
  tags,
  include,
  exclude,
  onChange,
}: {
  tags: Tag[]
  include: string[]
  exclude: string[]
  onChange: (include: string[], exclude: string[]) => void
}) {

  const [pick, setPick] = useState('')
  const [mode, setMode] = useState<'include' | 'exclude'>('include')
  const label = (id: string) => tags.find((t) => t.id === id)?.name ?? id

  return (
    <div>
      {/*
        U012: タグ名の選択は全幅の1行目、含む/含まないは別行へ。
        同じ行に並べると狭いパネルでタグ名が数文字に切れて読めなかった。
        選んだタグの札は下で複数行に広がり、全文を確認できる。
      */}
      <SaveErrorField names={["pick"]}><EntitySelect clearable size="full" kind="tag"
        aria-label="タグ名を選ぶ"
        placeholder="タグ名を選ぶ"
        value={pick}
        onChange={(id) => {
          if (!id) return
          if (mode === 'include') {
            if (!include.includes(id)) onChange([...include, id], exclude)
          } else if (!exclude.includes(id)) {
            onChange(include, [...exclude, id])
          }
          setPick('')
        }}
        options={tags.map((t) => ({ ...entityOptionMetadata(t), value: t.id, label: t.name }))}
        className="w-full"
      /></SaveErrorField>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SaveErrorField names={["mode"]}><Select
          aria-label="タグの含め方"
          value={mode}
          onChange={(value) => setMode(value as 'include' | 'exclude')}
          options={[
            { value: 'include', label: '付いている' },
            { value: 'exclude', label: '付いていない' },
          ]}
        /></SaveErrorField>
        {/* 設計の「タグフォルダで指定」。フォルダからタグを引く口が無い。 */}
        <button
          type="button"
          disabled
          title="タグフォルダからまとめて指定する口がまだありません"
          className="text-ink-faint text-xs opacity-50"
        >
          タグフォルダで指定
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <TagOverflow>{include.map((id) => (
          <TagPill key={id} name={label(id)} color={tags.find((tag) => tag.id === id)?.color}
            onRemove={() => onChange(include.filter((value) => value !== id), exclude)} />
        ))}</TagOverflow>
        <TagOverflow>{exclude.map((id) => (
          <span key={id} className="inline-flex items-center gap-1.5">
            <TagPill name={label(id)} color={tags.find((tag) => tag.id === id)?.color}
              onRemove={() => onChange(include, exclude.filter((value) => value !== id))} />
            <span>以外</span>
          </span>
        ))}</TagOverflow>
      </div>
    </div>
  )
}

type OrAxisInput = 'mark' | 'scenario' | 'date' | 'text' | null

const OR_AXES: Array<{
  label: string
  feature?: 'support_marks'
  input: OrAxisInput
  placeholder?: string
  make: (value: string) => SavedSearchCondition | null
}> = [
  { label: '対応マーク', feature: 'support_marks', input: 'mark', make: (value) => value ? { kind: 'mark', op: 'eq', value } : null },
  { label: 'シナリオ', input: 'scenario', make: (value) => value ? { kind: 'scenario', op: 'eq', value } : null },
  { label: 'イベント予約', input: null, make: () => ({ kind: 'event_booking', op: 'exists' }) },
  { label: 'カレンダー予約', input: null, make: () => ({ kind: 'calendar_booking', op: 'exists' }) },
  { label: '回答フォーム', input: null, make: () => ({ kind: 'form', op: 'exists' }) },
  { label: '最終反応日', input: 'date', make: (value) => value ? { kind: 'last_activity', op: 'after', value } : null },
  { label: 'リマインダ', input: null, make: () => ({ kind: 'reminder', op: 'exists' }) },
  { label: 'メモ', input: null, make: () => ({ kind: 'memo', op: 'exists' }) },
  { label: 'ステータスメッセージ', input: 'text', placeholder: '含む文字', make: (value) => value.trim() ? { kind: 'status_message', op: 'contains', value: value.trim() } : null },
  { label: '友だち登録日', input: 'date', make: (value) => value ? { kind: 'created_at', op: 'after', value } : null },
  { label: 'その他', input: 'text', placeholder: 'イベント種別（例：conversion）', make: (value) => value.trim() ? { kind: 'common_event', op: 'exists', value: value.trim() } : null },
]


/**
 * ORの軸1つぶん。値が要る軸は入力が揃うまで追加できない（FRIEND-03）。
 * 先頭の候補・固定の日付を勝手に使うことはない。
 */
function OrAxisPicker({
  axis,
  marks,
  scenarios,
  onAdd,
}: {
  axis: (typeof OR_AXES)[number]
  marks: Array<{ id: string; name: string }>
  scenarios: Scenario[]
  onAdd: (condition: SavedSearchCondition) => void
}) {
  const [draft, setDraft] = useState('')
  const options = axis.input === 'mark' ? marks : axis.input === 'scenario' ? scenarios : []
  const waitingForOptions = (axis.input === 'mark' || axis.input === 'scenario') && options.length === 0
  const condition = axis.make(draft)
  const addable = !waitingForOptions && (axis.input === null || condition !== null)

  return (
    <div className="flex max-w-xs flex-col gap-1">
      <span className="text-xs font-semibold text-ink-secondary">{axis.label}</span>
      <div className="flex items-center gap-1.5">
        {axis.input === 'mark' || axis.input === 'scenario' ? (
          <SaveErrorField names={["draft"]}><EntitySelect clearable size="full"
            aria-label={`${axis.label}を選ぶ`}
            placeholder="選ぶ"
            value={draft}
            onChange={setDraft}
            disabled={waitingForOptions}
            options={options.map((option) => ({ ...entityOptionMetadata(option), value: option.id, label: option.name }))}
            className="min-w-0 flex-1"
          /></SaveErrorField>
        ) : axis.input === 'date' ? (
          <SaveErrorField names={["draft"]}><DateField
            value={draft}
            onChange={setDraft}
            aria-label={`${axis.label}の日付（この日以降）`}
            className="min-w-0 flex-1"
          /></SaveErrorField>
        ) : axis.input === 'text' ? (
          <SaveErrorField names={["draft"]}><SharedTextField
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={axis.placeholder}
            aria-label={`${axis.label}の値`}
            className="border-hairline rounded-control bg-canvas text-ink min-w-0 flex-1 border px-2 py-1.5 text-xs"
          /></SaveErrorField>
        ) : null}
        <button
          type="button"
          disabled={!addable}
          onClick={() => {
            if (!condition) return
            onAdd(condition)
            setDraft('')
          }}
          className="shrink-0 rounded-pill border border-divider-soft bg-canvas-sunken px-3 py-1.5 text-xs text-ink-secondary"
        >
          ＋ 追加する
        </button>
      </div>
      {waitingForOptions ? <span className="text-ink-faint text-nano leading-tight">選択肢を読み込むと使えます</span> : null}
      {axis.input === 'date' ? <span className="text-ink-faint text-nano leading-tight">指定した日以降</span> : null}
    </div>
  )
}
