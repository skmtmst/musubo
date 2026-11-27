'use client'
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { useEffect, useRef, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronUp, GripVertical, Keyboard } from 'lucide-react'
import type { DashboardCardId } from '@line-crm/shared'
import {
  DASHBOARD_CARD_DEFINITIONS,
  TODAY_TASK_LIMIT,
  moveDashboardItem,
  reorderDashboardItems,
  toggleDashboardItem,
} from '@/components/dashboard/dashboard-editor'
import {
  V8_DASHBOARD_DEFAULT_VISIBILITY,
  defaultDashboardPreferences,
  type CardDefinition,
  type DashboardGroup,
  type DashboardPreferenceItem,
  type DashboardPreferences,
} from '@/components/dashboard/dashboard-preference-defaults'
import Drawer from '@/components/shared/drawer'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import Toggle from '@/components/shared/toggle'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ReorderHandle from '@/components/shared/reorder-handle'
import styles from './dashboard-editor.module.css'
import { dashboardCardForStyle } from './style-cards'
import TruncatedText from '@/components/shared/truncated-text'
import { SaveErrorField } from '@/components/shared/save-form-errors'


/*
 * ★V8 ダッシュボード編集（Pencil ）。V8 の入口（v8/dashboard/dashboard.tsx）からだけ開く。
 *
 * 動き（並べ替え・表示の ON/OFF・「今日やること」は4枠まで・初期状態に戻す・
 * 保存の失敗と 409・読み上げ）は 管理画面 と共有の `components/dashboard/dashboard-editor.tsx`
 * と同じ計算（reorder / move / toggle）をそのまま使い、見た目だけを絵どおりに組む。
 * 管理画面 の部品は変えない。
 *
 * - 引き出し 540（共通の Drawer width="editor"）。頭に「カードと配置／プレビュー」の切り替えと説明1行。
 * - 行：持ち手・名前と置き場所・上下（24 の枠つき）・スイッチ。OFF の行は薄い地。
 * - 4枠の注意は、5つ目を ON にした瞬間だけそのグループの上に出す（OFF にしたカードの名前を書く）。
 * - 下：左に「初期状態に戻す」（確認の窓 400 を挟む）、右に「閉じる」「ダッシュボードに反映」。
 * - 失敗は下の帯：保存できない（もう一度保存する）／ほかの人が変えた 409（最新の配置を読み込む）。
 * - キーボードで持ち上げている間だけ、操作の案内を下の帯に出す。
 */

const CARD_DEFINITION_MAP = new Map(DASHBOARD_CARD_DEFINITIONS.map((card) => [card.id, card]))
const GROUPS: DashboardGroup[] = ['today', 'main', 'right']
const GROUP_LABEL: Record<DashboardGroup, string> = { today: '今日やること', main: 'メイン', right: '右サイド' }
/* 絵の見出しの右の置き場所。右サイドは見出しだけ。 */
const GROUP_NOTE: Record<DashboardGroup, string | null> = {
  today: `上部・小カード（${TODAY_TASK_LIMIT}枠まで）`,
  main: '横長・左カラム',
  right: null,
}
export const KEYBOARD_HINT = '持ち上げるには Space を押し、上下の矢印キーで移動し、Space で置きます。Esc でやめます。'

const labelOf = (id: unknown) => CARD_DEFINITION_MAP.get(id as DashboardCardId)?.label ?? String(id)

function CardRow({ item, definition, canMoveUp, canMoveDown, disabled, onMove, onToggle }: {
  item: DashboardPreferenceItem
  definition: CardDefinition
  canMoveUp: boolean
  canMoveDown: boolean
  disabled: boolean
  onMove: (direction: 'up' | 'down') => void
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={styles.row}
      data-off={item.visible ? undefined : ''}
      data-dragging={isDragging ? '' : undefined}
    >
      {!disabled ? <ReorderHandle
        {...attributes}
        {...listeners}
        locked={disabled}
        label={definition.label}
        ariaLabel={`${definition.label}をドラッグして並べ替え`}
        className={styles.grip}
      >
        <GripVertical aria-hidden="true" />
      </ReorderHandle> : <span className={styles.grip} aria-hidden="true" />}
      <div className={styles.names}>
        <span className={styles.name} ><TruncatedText value={String(definition.label ?? '')} /></span>
        <span className={styles.where} title={definition.description}>{definition.description}</span>
      </div>
      <div role="group" aria-label={`${definition.label}の順番`} className={styles.moves}>
        <IconButton size="small" aria-label={`${definition.label}を1つ上へ移動`} disabled={disabled || !canMoveUp} onClick={() => onMove('up')}>
          <ChevronUp aria-hidden="true" />
        </IconButton>
        <IconButton size="small" aria-label={`${definition.label}を1つ下へ移動`} disabled={disabled || !canMoveDown} onClick={() => onMove('down')}>
          <ChevronDown aria-hidden="true" />
        </IconButton>
      </div>
      <SaveErrorField names={["visible","item.visible"]}><Toggle disabled={disabled} checked={item.visible} onChange={() => onToggle()} label={`${definition.label}を表示`} /></SaveErrorField>
    </div>
  )
}

/*
 * プレビュー（絵の 2）。実画面と同じ配置（3区分の並び）で、PC は「今日やること」4列＋
 * メインと右の左右、スマホは1列（390px の実画面は先頭2件＋「集計を見る」）。
 */
function Preview({ draft, usageStyle }: { draft: DashboardPreferences; usageStyle?: 'standard' | 'ec' }) {
  const [device, setDevice] = useState<'pc' | 'mobile'>('pc')
  const visible = (group: DashboardGroup) => draft[group].filter((item) => item.visible && dashboardCardForStyle(item.id, usageStyle))
  const today = visible('today')
  const total = GROUPS.reduce((count, group) => count + visible(group).length, 0)
  const mobileToday = today.slice(0, 2)
  const folded = today.length - mobileToday.length
  return (
    <div className={styles.preview}>
      <div className={styles.previewHead}>
        <p className={styles.hint}>実際のダッシュボードと同じ順番で表示します。</p>
        <SaveErrorField names={["device"]}><SegmentedControl<'pc' | 'mobile'>
          size="small"
          aria-label="プレビューの画面幅"
          value={device}
          onChange={setDevice}
          options={[{ value: 'pc', label: 'PC' }, { value: 'mobile', label: 'スマホ' }]}
        /></SaveErrorField>
      </div>
      <div className={styles.previewBoard}>
        {total === 0 ? <p className={styles.previewEmpty}>表示するカードがありません</p> : null}
        {device === 'pc' ? (
          <>
            {today.length > 0 ? (
              <div className={styles.previewSection}>
                <p className={styles.previewLabel}>{GROUP_LABEL.today}</p>
                <div className={styles.previewToday}>
                  {today.map((item) => <span key={item.id} className={styles.previewCard} data-small="">{labelOf(item.id)}</span>)}
                </div>
              </div>
            ) : null}
            <div className={styles.previewColumns}>
              <div className={styles.previewStack}>
                {visible('main').map((item) => <span key={item.id} className={styles.previewCard}>{labelOf(item.id)}</span>)}
              </div>
              <div className={styles.previewStack}>
                {visible('right').map((item) => <span key={item.id} className={styles.previewCard} data-aside="">{labelOf(item.id)}</span>)}
              </div>
            </div>
          </>
        ) : (
          <div className={styles.previewStack}>
            {mobileToday.map((item) => <span key={item.id} className={styles.previewCard} data-small="">{labelOf(item.id)}</span>)}
            {folded > 0 ? <span className={styles.previewCard} data-muted="">ほか {folded} 件（「集計を見る」で開きます）</span> : null}
            {visible('main').map((item) => <span key={item.id} className={styles.previewCard}>{labelOf(item.id)}</span>)}
            {visible('right').map((item) => <span key={item.id} className={styles.previewCard} data-aside="">{labelOf(item.id)}</span>)}
          </div>
        )}
      </div>
    </div>
  )
}

export default function DashboardEditorV8({ open, preferences, usageStyle, saving = false, saveError, saveConflict, onComparePreferences, onReloadPreferences, onCancel, onApply, onReset }: {
  open: boolean
  preferences: DashboardPreferences
  usageStyle?: 'standard' | 'ec'
  saving?: boolean
  /** 保存・初期化の失敗。引き出しの下の帯に出す（DASH-05）。 */
  saveError?: string | null
  /** 409 のとき true。「最新の配置を読み込む」を出す。 */
  onComparePreferences?: () => Promise<DashboardPreferences | null>
  saveConflict?: boolean
  /** 最新の配置を読み直し、成功したらその配置を返す（編集中の新しい起点）。 */
  onReloadPreferences?: () => Promise<DashboardPreferences | null>
  onCancel: () => void
  onApply: (next: DashboardPreferences) => void
  onReset?: () => void
}) {
  const [draft, setDraft] = useState(preferences)
  const [mode, setMode] = useState<'cards' | 'preview'>('cards')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [reloading, setReloading] = useState(false)
  const reloadingRef = useRef(false)
  const openSessionRef = useRef(0)
  const busyAll = saving || reloading
  /* 最後に押した保存の種類（失敗の帯の「もう一度」で同じ操作をやり直す）。 */
  const [lastAction, setLastAction] = useState<'apply' | 'reset'>('apply')
  /* 5つ目を ON にした瞬間だけ出す注意。OFF にしたカードの名前を持つ。開き直すと消える。 */
  const [limitNotice, setLimitNotice] = useState<string | null>(null)
  const [keyboardDrag, setKeyboardDrag] = useState(false)
  /* キーボードで持ち上げている間の Esc は「移動をやめる」。引き出しは閉じない。 */
  const keyboardDragRef = useRef(false)
  keyboardDragRef.current = keyboardDrag
  const close = () => {
    if (keyboardDragRef.current) return
    onCancel()
  }
  const [announcement, setAnnouncement] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /*
   * 編集中の draft は開いた時点の配置で固定する（DASH-15）。開いている間に
   * 遅れて届いた配置で、直している途中の内容を黙って上書きしない。
   */
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  useEffect(() => {
    openSessionRef.current += 1
    reloadingRef.current = false
    setReloading(false)
    if (open) {
      setDraft(preferencesRef.current)
      setMode('cards')
      setConfirmingReset(false)
      setLimitNotice(null)
      setKeyboardDrag(false)
    }
  }, [open])

  const toggle = (group: DashboardGroup, id: DashboardCardId) => {
    if (busyAll) return
    const before = draft[group]
    const next = toggleDashboardItem(before, id, group === 'today' ? TODAY_TASK_LIMIT : undefined)
    setDraft({ ...draft, [group]: next })
    if (group !== 'today') return
    /*
     * ON にした結果、上限を超えていちばん下が OFF になったときだけ注意を出す
     *（いちばん下が今 ON にしたカード自身なら、その名前を書く）。
     */
    const wasOff = before.find((item) => item.id === id)?.visible === false
    const turnedOff = wasOff
      ? before.find((item) => item.visible && !next.find((n) => n.id === item.id)?.visible)
        ?? (next.find((item) => item.id === id)?.visible ? undefined : before.find((item) => item.id === id))
      : undefined
    setLimitNotice(turnedOff ? labelOf(turnedOff.id) : null)
  }

  const handleDragStart = (event: DragStartEvent) => {
    setKeyboardDrag(typeof KeyboardEvent !== 'undefined' && event.activatorEvent instanceof KeyboardEvent)
  }

  const handleDragEnd = (group: DashboardGroup, event: DragEndEvent) => {
    setKeyboardDrag(false)
    if (busyAll) return
    const { active, over } = event
    if (busyAll || !over || active.id === over.id) return
    setDraft((current) => ({
      ...current,
      [group]: reorderDashboardItems(current[group], active.id as DashboardCardId, over.id as DashboardCardId),
    }))
  }

  /* 上下ボタンの移動。端では何もしない。結果は日本語で読み上げる。 */
  const handleMove = (group: DashboardGroup, id: DashboardCardId, direction: 'up' | 'down') => {
    if (busyAll) return
    const next = moveDashboardItem(draft[group], id, direction)
    if (next === draft[group]) return
    setDraft({ ...draft, [group]: next })
    setAnnouncement(`${labelOf(id)}を${next.findIndex((item) => item.id === id) + 1}番目へ移動しました`)
  }

  /* ドラッグ中の読み上げも日本語にする（dnd-kit の既定は英語で位置も言わない）。 */
  const announcements = (group: DashboardGroup): Announcements => {
    const positionOf = (id: unknown) => draft[group].findIndex((item) => item.id === id) + 1
    return {
      onDragStart: ({ active }) => `${labelOf(active.id)}を持ち上げました。今の位置は${positionOf(active.id)}番目です。`,
      onDragOver: ({ active, over }) => (!over || active.id === over.id ? undefined : `${labelOf(active.id)}を${labelOf(over.id)}の位置へ移動します。`),
      onDragEnd: ({ active, over }) => (!over || active.id === over.id
        ? `${labelOf(active.id)}の位置は変わりませんでした。`
        : `${labelOf(active.id)}を${positionOf(over.id)}番目へ移動しました。`),
      onDragCancel: ({ active }) => `${labelOf(active.id)}の移動をやめました。`,
    }
  }

  const apply = () => {
    if (busyAll) return
    setLastAction('apply')
    onApply(draft)
  }
  const reset = () => {
    if (busyAll) return
    setConfirmingReset(false)
    if (!onReset) {
      setDraft(defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY))
      return
    }
    setLastAction('reset')
    onReset()
  }
  const reloadLatest = async () => {
    if (!onReloadPreferences || reloadingRef.current) return
    const session = openSessionRef.current
    reloadingRef.current = true
    setReloading(true)
    try {
      const latest = await onReloadPreferences()
      if (latest && session === openSessionRef.current) setDraft(latest)
    } finally {
      if (session === openSessionRef.current) {
        reloadingRef.current = false
        setReloading(false)
      }
    }
  }

  const saveCollision = useSaveConflict<DashboardPreferences>({ fetchLatest: onComparePreferences ?? (async () => null), reload: reloadLatest })
  const conflict = Boolean(saveError && saveConflict && onReloadPreferences)
  const band = saveError || keyboardDrag ? (
    <>
      {saveError && !conflict ? (
        <Notice
          tone="danger"
          message={saveError}
          action={(
            <Button size="compact" onClick={() => (lastAction === 'reset' ? reset() : apply())} disabled={busyAll}>
              {lastAction === 'reset' ? 'もう一度試す' : 'もう一度保存する'}
            </Button>
          )}
        />
      ) : null}
      {conflict ? (
        <SaveConflictBand title="ほかの人が先にダッシュボードの配置を保存しました" compareBusy={saveCollision.compareBusy} onCompare={() => void saveCollision.compare()} onReload={() => void saveCollision.reloadLatest()} />
      ) : null}
      {keyboardDrag ? <Notice tone="info" icon={<Keyboard size={16} />} message={KEYBOARD_HINT} /> : null}
    </>
  ) : undefined

  return (
    <>
      <SaveConflictCompareDialog open={saveCollision.compareOpen} error={saveCollision.compareError} busy={saveCollision.compareBusy} lines={saveCollision.latest ? [{ text: JSON.stringify(draft) === JSON.stringify(saveCollision.latest) ? '配置に違いはありません' : '表示する項目や順番が異なります。最新を読み込むと、相手が保存した配置に切り替わります。' }] : null} onReload={() => void saveCollision.reloadLatest()} onCancel={saveCollision.closeCompare} />
      <Drawer
        open={open}
        width="editor"
        title="ダッシュボード編集"
        description="表示するカードと位置を変更します"
        dirty={JSON.stringify(draft) !== JSON.stringify(preferences)}
        busy={busyAll}
        onClose={close}
        toolbar={(
          <div className={styles.toolbar}>
            <SaveErrorField names={["mode"]}><SegmentedControl<'cards' | 'preview'>
              aria-label="ダッシュボード編集の表示"
              value={mode}
              onChange={setMode}
              options={[{ value: 'cards', label: 'カードと配置' }, { value: 'preview', label: 'プレビュー' }]}
            /></SaveErrorField>
            {mode === 'cards' ? (
              <p className={styles.hint}>持ち手をドラッグして移動。上下ボタン・キーボードでも順番を変更。スイッチで表示を切り替えます。</p>
            ) : null}
          </div>
        )}
        band={band}
        footer={(
          <div className={styles.footer} data-design-node="mcOqK">
            <button type="button" className={styles.resetLink} disabled={busyAll} onClick={() => (onReset ? setConfirmingReset(true) : reset())}>
              初期状態に戻す
            </button>
            <span className={styles.spacer} />
            <Button onClick={close} disabled={busyAll}>閉じる</Button>
            <Button variant="primary" onClick={apply} disabled={busyAll} busy={saving}>ダッシュボードに反映</Button>
          </div>
        )}
      >
        {/* 上下ボタンで動かした結果を読み上げる（見た目には出さない）。 */}
        <p role="status" className="sr-only">{announcement}</p>
        {mode === 'preview' ? <Preview draft={draft} usageStyle={usageStyle} /> : (
          <div className={styles.groups}>
            {GROUPS.map((group) => (
              <section key={group} className={styles.group} aria-labelledby={`dashboard-editor-${group}`}>
                <div className={styles.groupHead}>
                  <h3 id={`dashboard-editor-${group}`} className={styles.groupTitle}>{GROUP_LABEL[group]}</h3>
                  {GROUP_NOTE[group] ? <span className={styles.groupNote}>{GROUP_NOTE[group]}</span> : null}
                </div>
                {group === 'today' && limitNotice ? (
                  <Notice tone="warn" icon={null}>
                    <span className={styles.limitTitle}>「今日やること」は{TODAY_TASK_LIMIT}枠までです</span>
                    <span className={styles.limitText}>{`${TODAY_TASK_LIMIT + 1}つ目をONにしたので、いちばん下の「${limitNotice}」をOFFにしました。先に出したい${TODAY_TASK_LIMIT}つを上に並べてください。`}</span>
                  </Notice>
                ) : null}
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  accessibility={{ announcements: announcements(group), screenReaderInstructions: { draggable: KEYBOARD_HINT } }}
                  onDragStart={handleDragStart}
                  onDragCancel={() => setKeyboardDrag(false)}
                  onDragEnd={(event) => handleDragEnd(group, event)}
                >
                  <SortableContext items={draft[group].map((item) => item.id)} strategy={verticalListSortingStrategy}>
                    <div className={styles.rows}>
                      {draft[group].map((item, index) => {
                        if (!dashboardCardForStyle(item.id, usageStyle)) return null
                        const definition = CARD_DEFINITION_MAP.get(item.id)
                        if (!definition) return null
                        return (
                          <CardRow
                            key={item.id}
                            item={item}
                            definition={definition}
                            disabled={busyAll}
                            canMoveUp={index > 0}
                            canMoveDown={index < draft[group].length - 1}
                            onMove={(direction) => handleMove(group, item.id, direction)}
                            onToggle={() => toggle(group, item.id)}
                          />
                        )
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              </section>
            ))}
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={confirmingReset}
        title="初期状態に戻す"
        description="現在の配置を削除して初期状態へ戻します。この操作はすぐに保存され、あとからキャンセルしても元には戻りません。"
        confirmLabel="削除して初期状態へ戻す"
        destructive
        titleIcon={false}
        confirmIcon={false}
        designWidth={400}
        busy={busyAll}
        onConfirm={reset}
        onCancel={() => setConfirmingReset(false)}
      />
    </>
  )
}
