'use client'
import CloseButton from '@/components/shared/close-button'
import { eventsApi } from '@/lib/api';

import { SaveErrorField } from '@/components/shared/save-form-errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import { Bell, Calendar, FileText, Flag, MessageSquare, Tag, User, Variable, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import styles from './action-editor.module.css'
import Button from '@/components/shared/button'
import { ActionAddButton, ActionDragHandle, ActionRow, type ActionChoice } from '@/components/shared/action-list'
import { useReorder } from '@/components/shared/row-actions'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { EntityKindField, type EntityKind } from '@/components/shared/entity-picker-sources'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import {
  api,
  describeSaveFailure,
  type ScenarioAction,
  type ScenarioActionHook,
  type ScenarioActionType,
  type ScenarioDraftActionV6,
} from '@/lib/api'
import Notice from '@/components/shared/notice'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import ConditionBuilder, {
  findConditionDraftIssue as findSharedConditionDraftIssue,
  findInvalidRangeIssue,
  type SegmentCondition,
} from '@/components/shared/condition-builder'
import { useAccount } from '@/contexts/account-context'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { scenarioReferenceData } from './scenario-reference-data'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import InlineSettings from '@/components/shared/inline-settings'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
import { ToggleField } from '@/components/shared/toggle'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

/*
 * シナリオのアクションを編集する窓（設計 `管理画面 5 hz9ti 送信後のアクションを設定`）。
 *
 * 段の並びは設計に合わせて **「追加する動作を選ぶ」が先、「実行する動作」が後**。
 * 先に一覧を出して最後に追加口を置くと、まだ1つも無いときに何をすれば
 * いいのかが画面の一番下にしか無く、空の枠だけを見て手が止まる。
 *
 * 動作を番号つきのカードで積む形は変えていない。カードごとに条件・
 * 並べ替え・削除を置く。種別ごとに窓を分けると、「タグを付けてから、
 * そのタグを条件に次を動かす」が書けなくなる。
 *
 * 保存は操作のたびにすぐ行う。まとめて保存にすると、途中で閉じたときに
 * どこまで残ったかが分からない。打った値はまず画面に写し、保存は裏で
 * 1本の列に並べる（R244）。キャンセルは開いたときの状態に戻す（R242）。
 * 条件だけは下書きを持ち、「条件を保存」で保存する（R243）。
 *
 * 設計にあって、ここに置いていないもの:
 *
 *   - 共通設定の「アクション名」「フォルダ」と「保存済みセットの呼出し」…
 *     `scenario_actions` に名前もフォルダもセットの口も無く、読む口も
 *     書く口も無い。入口だけ置くと、書いたものが消えたように見える・
 *     保存できるように見えて設定済みだと誤認させる（R241）。
 *   - 8つの動作 … 現行の編集口が持つ種別は `ScenarioActionType` の5つ。
 *     変更時は、安全に変換できる設定を管理画面下書きAPIへ同時保存する
 *   - 「発動2回目以降も各動作を実行」をセクションに1つ … `repeatOnRefire` は
 *     動作1件ごとの列。1つにまとめると、動作ごとに違う値を持てなくなり、
 *     既にある設定を黙って上書きすることになる
 */

export const ACTION_KINDS: {
  feature?: 'friend_fields' | 'support_marks' | 'common_vars'
  type: ScenarioActionType
  label: string
  /** 札の上に出す目印（設計 18px）。文字だけだと5つが同じ形に見える。 */
  icon: LucideIcon
  make: () => unknown
}[] = [
  { type: 'tag', label: 'タグ操作', icon: Tag, make: () => ({ op: 'add', tagIds: [] }) },
  {
    type: 'friend_field',
    label: '友だち情報操作',
    feature: 'friend_fields',
    icon: User,
    make: () => ({ fieldId: '', op: 'set', value: '' }),
  },
  { type: 'support_mark', label: '対応マーク操作', feature: 'support_marks', icon: Flag, make: () => ({ markId: null }) },
  {
    type: 'scenario',
    label: 'シナリオ操作',
    icon: Workflow,
    make: () => ({ op: 'start', scenarioId: '', restart: 'from_start' }),
  },
  {
    type: 'common_var',
    label: '共通情報操作',
    feature: 'common_vars',
    icon: Variable,
    make: () => ({ varKey: '', op: 'add', value: '1' }),
  },
  { type: 'send_message', label: 'テキスト送信', icon: MessageSquare, make: () => ({ content: '' }) },
  { type: 'send_template', label: 'テンプレート送信', icon: FileText, make: () => ({ templateId: '' }) },
  { type: 'reminder', label: 'リマインダ操作', icon: Bell, make: () => ({ reminderId: '' }) },
  { type: 'event_booking', label: 'イベント予約操作', icon: Calendar, make: () => ({ eventId: '' }) },
]

const KIND_LABEL: Record<ScenarioActionType, string> = {
  tag: 'タグ操作',
  friend_field: '友だち情報操作',
  support_mark: '対応マーク操作',
  scenario: 'シナリオ操作',
  common_var: '共通情報操作',
  send_message: 'テキスト送信',
  send_template: 'テンプレート送信',
  reminder: 'リマインダ操作',
  event_booking: 'イベント予約操作',
}

/** 既存5種を、機能5 管理画面の下書き契約へ安全に写せる形だけ変換する。 */
function toDraftActions(actions: ScenarioAction[]): ScenarioDraftActionV6[] {
  return actions.flatMap<ScenarioDraftActionV6>((action, actionIndex) => {
    const config = (action.config ?? {}) as Record<string, unknown>
    const common = {
      hook: action.hook,
      stepId: action.stepId,
      choiceKey: action.choiceIndex === null ? null : String(action.choiceIndex),
      condition: action.condition,
      onFailure: 'stop' as const,
    }
    if (action.actionType === 'tag') {
      const ids = Array.isArray(config.tagIds)
        ? config.tagIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
      return ids.map((tagId, index) => ({
        ...common,
        id: `${action.id}-${index}`,
        type: config.op === 'remove' ? 'remove_tag' : 'add_tag',
        params: { tagId },
        sortOrder: actionIndex * 10 + index,
      }))
    }
    if (action.actionType === 'support_mark' && typeof config.markId === 'string' && config.markId) {
      return [{
        ...common,
        id: action.id,
        type: 'set_support_mark',
        params: { supportMarkId: config.markId },
        sortOrder: actionIndex * 10,
      }]
    }
    if (action.actionType === 'scenario' && typeof config.scenarioId === 'string' && config.scenarioId) {
      const type = config.op === 'stop' ? 'stop_scenario' : 'start_scenario'
      return [{
        ...common,
        id: action.id,
        type,
        params: { scenarioId: config.scenarioId },
        sortOrder: actionIndex * 10,
      }]
    }
    if (
      action.actionType === 'friend_field'
      && typeof config.fieldId === 'string'
      && config.fieldId
      && config.op === 'set'
    ) {
      return [{
        ...common,
        id: action.id,
        type: 'set_metadata',
        params: { values: { [config.fieldId]: config.value ?? '' } },
        sortOrder: actionIndex * 10,
      }]
    }
    if (action.actionType === 'send_message' && typeof config.content === 'string' && config.content.trim()) {
      return [{ ...common, id: action.id, type: 'send_message', params: { content: config.content }, sortOrder: actionIndex * 10 }]
    }
    if (action.actionType === 'send_template' && typeof config.templateId === 'string' && config.templateId) {
      return [{ ...common, id: action.id, type: 'send_message', params: { templateId: config.templateId }, sortOrder: actionIndex * 10 }]
    }
    if (action.actionType === 'reminder' && typeof config.reminderId === 'string' && config.reminderId) {
      return [{ ...common, id: action.id, type: 'start_reminder', params: { reminderId: config.reminderId }, sortOrder: actionIndex * 10 }]
    }
    if (action.actionType === 'event_booking' && typeof config.eventId === 'string' && config.eventId) {
      return [{ ...common, id: action.id, type: 'event_booking', params: config, sortOrder: actionIndex * 10 }]
    }
    return []
  })
}

interface Option {
  id: string
  name: string
}

export interface ActionTargetOption extends Option {
  /** 行の右に出す補足（種別・状態など）。無ければ出さない。 */
  hint?: string
  /** 選んだ対象の内容の抜粋（テンプレートの本文など）。無ければ出さない。 */
  excerpt?: string
}

export interface ActionLookups {
  tags: Option[]
  fields: Option[]
  marks: Option[]
  scenarios: Option[]
  vars: { varKey: string; name: string }[]
  templates: ActionTargetOption[]
  reminders: ActionTargetOption[]
  events: ActionTargetOption[]
}

/** 長い本文を見出し用に切る。途中で切ったことが分かるよう「…」を付ける。 */
function truncateSummary(text: string, length = 24): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > length ? `${trimmed.slice(0, length)}…` : trimmed
}

/*
 * R240: 動作の見出しと要約は、行番号ではなく実際の種別・対象・値から作る。
 * 並べ替えで変わるのは順序番号だけにする。
 */
export function describeAction(action: ScenarioAction, lookups: ActionLookups): string {
  const c = (action.config ?? {}) as Record<string, unknown>
  const tagNames = (ids: unknown) =>
    (Array.isArray(ids) ? ids : [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => lookups.tags.find((t) => t.id === id)?.name ?? '名称不明のタグ')
  switch (action.actionType) {
    case 'tag': {
      const names = tagNames(c.tagIds)
      return `${c.op === 'remove' ? 'タグをはずす' : 'タグを追加'}${names.length > 0 ? `「${names.join('・')}」` : '（タグ未選択）'}`
    }
    case 'friend_field': {
      const field = typeof c.fieldId === 'string' ? lookups.fields.find((f) => f.id === c.fieldId)?.name : undefined
      if (!field) return '項目未選択'
      const value = String(c.value ?? '')
      if (c.op === 'clear') return `「${field}」を消去`
      if (c.op === 'add') return `「${field}」に「${value}」を足す`
      if (c.op === 'sub') return `「${field}」から「${value}」を引く`
      return `「${field}」に「${value}」を入れる`
    }
    case 'support_mark': {
      const mark = typeof c.markId === 'string' && c.markId
        ? lookups.marks.find((m) => m.id === c.markId)?.name
        : undefined
      return mark ? `対応マークを「${mark}」に変更` : 'マークを外す'
    }
    case 'scenario': {
      if (c.op === 'resume_previous') return '1つ前のシナリオを再開'
      const name = typeof c.scenarioId === 'string' && c.scenarioId
        ? lookups.scenarios.find((s) => s.id === c.scenarioId)?.name
        : undefined
      if (c.op === 'stop') return name ? `「${name}」の購読を止める` : 'このシナリオの購読を止める'
      return name ? `「${name}」の購読を始める` : '（シナリオ未選択）'
    }
    case 'common_var': {
      const target = typeof c.varKey === 'string' ? lookups.vars.find((v) => v.varKey === c.varKey)?.name : undefined
      if (!target) return '共通情報未選択'
      return `「${target}」に「${String(c.value ?? '')}」を${c.op === 'sub' ? '引く' : '足す'}`
    }
    case 'send_message': {
      const content = typeof c.content === 'string' ? c.content.trim() : ''
      return content ? `「${truncateSummary(content)}」を送信` : '本文未入力'
    }
    case 'send_template': {
      const target = typeof c.templateId === 'string' && c.templateId
        ? lookups.templates.find((t) => t.id === c.templateId)?.name
        : undefined
      return target ? `テンプレート「${target}」を送信` : 'テンプレート未選択'
    }
    case 'reminder': {
      const target = typeof c.reminderId === 'string' && c.reminderId
        ? lookups.reminders.find((t) => t.id === c.reminderId)?.name
        : undefined
      return target ? `リマインダ「${target}」` : 'リマインダ未選択'
    }
    case 'event_booking': {
      const target = typeof c.eventId === 'string' && c.eventId
        ? lookups.events.find((t) => t.id === c.eventId)?.name
        : undefined
      if (! target) return 'イベント予約未選択'
      const operation = c.op === 'cancel' ? '申し込みを取り消す' : 'イベントに申し込む'
      const slot = typeof c.slotId === 'string' && c.slotId ? '（選んだ回）' : ''
      return `${operation}「${target}」${slot}`
    }
    default:
      return '設定した内容を実行'
  }
}

/*
 * R243: 編集中の未完成行は保持し、保存のときに入力不足を案内する。
 * 未完成のまま黙って「条件なし」に置き換えない。
 * 判定は共通のものを使う。空のかたまりだけの下書きも止める。
 */
export function findConditionDraftIssue(draft: SegmentCondition | null): string | null {
  return findSharedConditionDraftIssue(draft)
}

export interface ActionEditorProps {
  scenarioId: string
  accountId?: string | null
  hook: ScenarioActionHook
  stepId?: string | null
  choiceIndex?: number | null
  /** 見出しに出す説明。「この通を送ったあと」など。 */
  title: string
  onClose: () => void
  /** 保存のたびに呼ぶ。件数バッジの更新に使う。 */
  onChanged?: () => void
}

export default function ActionEditor({
  scenarioId,
  accountId,
  hook,
  stepId = null,
  choiceIndex = null,
  title,
  onClose,
  onChanged,
}: ActionEditorProps) {
  const { selectedAccountId: contextAccountId } = useAccount()
  const selectedAccountId = accountId === undefined ? contextAccountId : accountId
  // 共通の窓の約束: Escapeで閉じる・Tabは窓の中・閉じたら起点へ戻す。
  const pendingRef = useRef(0)
  const [pendingCount, setPendingCount] = useState(0)
  const errorRef = useRef('')
  const retryRef = useRef<(() => Promise<void>) | null>(null)
  // 任意機能の動作種は、そのaccountで機能がオフなら追加口ごと出さない。
  const actionFeatureVisibility = useFeatureVisibility(selectedAccountId)
  const [actions, setActions] = useState<ScenarioAction[]>([])
  const actionsRef = useRef<ScenarioAction[]>([])
  const setActionsSync = (next: ScenarioAction[]) => {
    actionsRef.current = next
    setActions(next)
  }
  const [loading, setLoading] = useState(true)
  const [draftReady, setDraftReady] = useState(false)
  const [reload, setReload] = useState(0)
  const scope = `${scenarioId}:${selectedAccountId}:${hook}:${stepId}:${choiceIndex}`
  const scopeRef = useRef({ key: scope, generation: 0 })
  if (scopeRef.current.key !== scope) {
    scopeRef.current = { key: scope, generation: scopeRef.current.generation + 1 }
  }
  const scopeSubject = scopeRef.current
  const [error, setErrorState] = useState('')
  const setError = (message: string) => { errorRef.current = message; setErrorState(message) }
  const [conditionFor, setConditionFor] = useState<string | null>(null)
  /*
   * R243: 条件は編集中の下書きとして持ち、保存のときだけ整える。
   * 入力のたびに作り直して欄を閉じたり、空値を取り除いたりしない。
   */
  const [conditionDraft, setConditionDraft] = useState<SegmentCondition | null>(null)
  const [conditionError, setConditionError] = useState('')
  const [conditionSaving, setConditionSaving] = useState(false)
  const conditionBaseline = useRef('null')
  const conditionGuard = useUnsavedGuard({
    dirty: conditionFor !== null && JSON.stringify(conditionDraft) !== conditionBaseline.current,
    busy: conditionSaving,
    subject: '動作の条件',
    onDiscard: () => { setConditionFor(null); setConditionDraft(null) },
  })
  const closeWhenSaved = () => { if (!pendingRef.current && !errorRef.current) conditionGuard.guarded(onClose) }
  /*
   * R244: 内容編集の開閉は画面側で持つ。保存のたびに作り直して閉じない。
   * R242: キャンセルは開く前の値に戻すための、開いたときの写し。
   */
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const initialRef = useRef<ScenarioAction[] | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [draftVersion, setDraftVersion] = useState(0)
  const draftVersionRef = useRef(0)
  const [draftSaving, setDraftSaving] = useState(false)
  /* 打ち続けても保存の順序が入れ替わらないよう、保存は1本の列に並べる。 */
  const saveQueueRef = useRef(Promise.resolve())

  const [tags, setTags] = useState<Option[]>([])
  const [fields, setFields] = useState<Option[]>([])
  const [marks, setMarks] = useState<Option[]>([])
  const [scenarioOpts, setScenarioOpts] = useState<Option[]>([])
  const [vars, setVars] = useState<{ varKey: string; name: string }[]>([])
  /* R245: テンプレート・リマインダ・イベント予約は名前で選ぶための候補。 */
  const [templates, setTemplates] = useState<ActionTargetOption[]>([])
  const [reminders, setReminders] = useState<ActionTargetOption[]>([])
  const [events, setEvents] = useState<ActionTargetOption[]>([])
  const [targetsLoading, setTargetsLoading] = useState(false)

  const lookups: ActionLookups = {
    tags,
    fields,
    marks,
    scenarios: scenarioOpts,
    vars,
    templates,
    reminders,
    events,
  }

  /* 一覧の取得。表示の作り直しは呼び出し側が決める。 */
  const fetchActions = useCallback(async (): Promise<ScenarioAction[]> => {
    const at = scopeSubject
    if (at !== scopeRef.current) return []
    const res = await api.scenarios.actions.list(scenarioId)
    if (scopeRef.current !== at) return []
    if (!res.success) {
      throw new Error(res.error)
    }
    return res.data.filter(
        (a) =>
          a.hook === hook &&
          (a.stepId ?? null) === (stepId ?? null) &&
          (a.choiceIndex ?? null) === (choiceIndex ?? null),
      )
  }, [scenarioId, selectedAccountId, hook, stepId, choiceIndex, scopeSubject])

  /* 初回の読み込みだけ「読み込んでいます」を出す。R244: 保存のたびに
   * 作り直して編集欄を閉じないよう、更新時は黙って入れ替える。 */
  const load = useCallback(async (): Promise<ScenarioAction[]> => {
    const at = scopeSubject
    setLoading(true)
    try {
      const next = await fetchActions()
      if (scopeRef.current !== at) return []
      setActionsSync(next)
      if (initialRef.current === null) initialRef.current = next
      return next
    } finally { if (scopeRef.current === at) setLoading(false) }
  }, [fetchActions, scopeSubject])

  /* 保存後の読み直し。開いている編集欄・入力焦点を残すため、読み込み中の
   * 表示には切り替えない。 */
  const refresh = useCallback(async (): Promise<ScenarioAction[]> => {
    const at = scopeSubject
    const next = await fetchActions()
    if (scopeRef.current === at) setActionsSync(next)
    return next
  }, [fetchActions, scopeSubject])

  const saveDraftSnapshot = async (next: ScenarioAction[]) => {
    if (scopeSubject !== scopeRef.current) return false
    if (!selectedAccountId) {
      setError('LINE公式アカウントを選んでください')
      return false
    }
    const at = scopeSubject
    setDraftSaving(true)
    try {
      const current = await api.scenarios.getDraft(scenarioId, selectedAccountId)
      if (at !== scopeRef.current) return false
      if (!current.success) throw new Error(current.error)
      const siblings = (current.data?.afterActions ?? []).filter((action) =>
        action.hook !== hook || (action.stepId ?? null) !== stepId ||
        (action.choiceKey ?? null) !== (choiceIndex === null ? null : String(choiceIndex)))
      const response = await api.scenarios.saveDraft(scenarioId, {
        lineAccountId: selectedAccountId,
        expectedVersion: draftVersionRef.current,
        afterActions: [...siblings, ...toDraftActions(next)],
      })
      if (at !== scopeRef.current) return false
      if (!response.success) {
        setError(response.error)
        return false
      }
      draftVersionRef.current = response.data.version
      setDraftVersion(response.data.version)
      return true
    } catch (saveError) {
      if (at !== scopeRef.current) return false
      setError(describeSaveFailure(saveError))
      return false
    } finally {
      if (at === scopeRef.current) setDraftSaving(false)
    }
  }

  /* 保存は1本の列に並べる。打ち続けても順序が入れ替わらない。 */
  const enqueue = (task: () => Promise<void>, retrySafe = false) => {
    const at = scopeSubject
    pendingRef.current += 1
    setPendingCount(pendingRef.current)
    const run = saveQueueRef.current.then(() => { if (at === scopeRef.current) return task() }).catch((caught) => {
      if (at !== scopeRef.current) return
      setError(describeSaveFailure(caught))
      retryRef.current = retrySafe ? async () => {
        // 古い操作の写しを再送せず、その後に打ち足した現在の入力を保存する。
        const latest = actionsRef.current
        for (const action of latest) {
          if (at !== scopeRef.current) return
          const response = await api.scenarios.actions.update(scenarioId, action.id, {
            config: action.config, condition: action.condition,
            repeatOnRefire: action.repeatOnRefire, sortOrder: action.sortOrder,
          })
          if (!response.success) throw new Error(response.error)
        }
        if (!await saveDraftSnapshot(latest)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
        onChanged?.()
      } : null
    }).finally(() => {
      if (at === scopeRef.current) {
        pendingRef.current -= 1
        setPendingCount(pendingRef.current)
      }
    })
    saveQueueRef.current = run
    return run
  }

  useEffect(() => {
    pendingRef.current = 0
    setPendingCount(0)
    saveQueueRef.current = Promise.resolve()
    retryRef.current = null
  }, [scopeSubject])

  useEffect(() => {
    let cancelled = false
    setActionsSync([]); initialRef.current = null; setError(''); setDraftReady(false)
    draftVersionRef.current = 0; setDraftVersion(0); setDraftSaving(false)
    void Promise.all([
      load(),
      selectedAccountId
        ? api.scenarios.getDraft(scenarioId, selectedAccountId)
        : Promise.resolve(null),
    ]).then(([, draftResponse]) => {
      if (cancelled) return
      if (!draftResponse?.success) { setError('下書きを読み込めませんでした。もう一度読み込んでください。'); return }
      setDraftReady(true)
      const version = draftResponse?.success && draftResponse.data ? draftResponse.data.version : 0
      draftVersionRef.current = version
      setDraftVersion(version)
    }).catch((caught) => { if (!cancelled) setError(japaneseDetailOf(caught) || '下書きを読み込めませんでした。') })
    return () => {
      cancelled = true
    }
  }, [load, scenarioId, selectedAccountId, reload])

  useEffect(() => {
    let cancelled = false
    setTags([]); setFields([]); setMarks([]); setScenarioOpts([]); setVars([]); setTemplates([]); setReminders([]); setEvents([])
    if (!selectedAccountId) {
      setMarks([])
      return
    }
    void (async () => {
      setTargetsLoading(true)
      try {
      const toOption = (row: unknown): Option => {
        const record = (row ?? {}) as Record<string, unknown>
        return {
          id: String(record.id ?? ''),
          name: String(record.name ?? '名称未設定'),
        }
      }
      const [tagRes, fieldRes, markRes, scenarioRes, varRes, templateRes, reminderRes, eventRes] =
        await Promise.all([
          scenarioReferenceData.tags(selectedAccountId),
          scenarioReferenceData.friendFields(selectedAccountId),
          scenarioReferenceData.supportMarks(selectedAccountId),
          scenarioReferenceData.scenarios(selectedAccountId),
          scenarioReferenceData.commonVars(selectedAccountId),
          scenarioReferenceData.templates(selectedAccountId),
          scenarioReferenceData.reminders(selectedAccountId),
          scenarioReferenceData.events(selectedAccountId),
        ])
      if (cancelled) return
      if ([tagRes, fieldRes, markRes, scenarioRes, varRes, templateRes, reminderRes, eventRes].some(response => !response.success)) throw new Error('Reference data failed')
      if (tagRes.success) setTags(tagRes.data.map((t) => ({ id: t.id, name: t.name })))
      if (fieldRes.success) setFields(fieldRes.data.map((f) => ({ id: f.id, name: f.name })))
      if (markRes.success) setMarks(markRes.data.map((m) => ({ id: m.id, name: m.name })))
      if (scenarioRes.success)
        setScenarioOpts(
          scenarioRes.data.filter((s) => s.id !== scenarioId).map((s) => ({ id: s.id, name: s.name })),
        )
      if (varRes.success) setVars(varRes.data.map((v) => ({ varKey: v.varKey, name: v.name })))
      /* R245: 対象はアカウントで絞った候補から名前で選ぶ。 */
      if (templateRes.success) {
        setTemplates(
          templateRes.data.map((t) => {
            const record = (t ?? {}) as Record<string, unknown>
            const content = typeof record.messageContent === 'string' ? record.messageContent : ''
            const excerpt = content.trim().replace(/\s+/g, ' ').slice(0, 80)
            return { ...toOption(t), excerpt: excerpt || undefined }
          }),
        )
      }
      if (reminderRes.success) setReminders(reminderRes.data.map(toOption))
      if (eventRes.success) {
        setEvents(
          eventRes.data.map((e) => {
            const record = (e ?? {}) as unknown as Record<string, unknown>
            return {
              ...toOption(e),
              hint: record.is_published ? '公開中' : '下書き',
            }
          }),
        )
      }
      } catch { if (!cancelled) setError('候補を読み込めませんでした。もう一度お試しください。') }
      finally { if (!cancelled) setTargetsLoading(false) }
    })()
    return () => { cancelled = true }
  }, [scenarioId, selectedAccountId, reload])

  const add = (kind: (typeof ACTION_KINDS)[number], config = kind.make()) => {
    setError('')
    void enqueue(async () => {
      const res = await api.scenarios.actions.create(scenarioId, {
        hook,
        stepId,
        choiceIndex,
        actionType: kind.type,
        config,
        repeatOnRefire: true,
      })
      if (!res.success) {
        throw new Error(res.error)
      }
      const fresh = await refresh()
      setExpandedId(res.data.id)
      if (!await saveDraftSnapshot(fresh)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
      onChanged?.()
    })
  }

  /*
   * R244: 打った値はまず画面に写し、保存は裏で列に並べる。保存に失敗しても
   * 入力は残し、欄外の文で知らせる。読み直しで編集欄を作り直さない。
   */
  const save = (action: ScenarioAction, patch: Partial<ScenarioAction>) => {
    setError('')
    const next = actionsRef.current.map((a) => (a.id === action.id ? { ...a, ...patch } : a))
    setActionsSync(next)
    void enqueue(async () => {
      const res = await api.scenarios.actions.update(scenarioId, action.id, {
        config: patch.config ?? action.config,
        condition: patch.condition !== undefined ? patch.condition : action.condition,
        repeatOnRefire: patch.repeatOnRefire ?? action.repeatOnRefire,
        sortOrder: patch.sortOrder ?? action.sortOrder,
      })
      if (!res.success) {
        throw new Error(res.error)
      }
      if (!await saveDraftSnapshot(next)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
      onChanged?.()
    }, true)
  }

  const remove = (action: ScenarioAction) => {
    setError('')
    if (expandedId === action.id) setExpandedId(null)
    setActionsSync(actionsRef.current.filter((a) => a.id !== action.id))
    void enqueue(async () => {
      const res = await api.scenarios.actions.remove(scenarioId, action.id)
      if (!res.success) {
        setError(res.error)
        await refresh()
        return
      }
      const fresh = await refresh()
      if (!await saveDraftSnapshot(fresh)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
      onChanged?.()
    })
  }

  /** 上下の入れ替え。並び順は実行順なので、見た目と実行が一致している必要がある。 */

  /* R243: 条件の窓を開くとき、下書きに写して持つ。入力のたびに保存しない。 */
  const openCondition = (action: ScenarioAction) => {
    setConditionError('')
    conditionBaseline.current = JSON.stringify(action.condition ?? null)
    setConditionDraft((action.condition as SegmentCondition | null) ?? null)
    setConditionFor(action.id)
  }

  /* R243: 保存のときだけ整える。未完成があれば欄を残して不足を案内する。 */
  const saveCondition = () => {
    const target = actionsRef.current.find((a) => a.id === conditionFor)
    if (!target) {
      setConditionFor(null)
      return
    }
    const issue = findConditionDraftIssue(conditionDraft) ?? findInvalidRangeIssue(conditionDraft)
    if (issue) {
      setConditionError(issue)
      return
    }
    setConditionError('')
    setConditionSaving(true)
    void enqueue(async () => {
      try {
        const res = await api.scenarios.actions.update(scenarioId, target.id, {
          condition: conditionDraft,
        })
        if (!res.success) {
          setError(res.error)
          return
        }
        const fresh = await refresh()
        if (!await saveDraftSnapshot(fresh)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
        onChanged?.()
        conditionGuard.disarm()
        setConditionFor(null)
      } finally {
        setConditionSaving(false)
      }
    })
  }

  /*
   * R242: キャンセルは開く前の値に戻す。足したものは消し、消したものは
   * 作り直し、変えたものは書き戻してから閉じる。
   */
  const cancel = () => {
    const initial = initialRef.current
    if (!initial) {
      onClose()
      return
    }
    setCancelling(true)
    setError('')
    void enqueue(async () => {
      try {
        const current = await fetchActions()
        const initialIds = new Set(initial.map((a) => a.id))
        for (const a of current) {
          if (!initialIds.has(a.id)) {
            const res = await api.scenarios.actions.remove(scenarioId, a.id)
            if (!res.success) throw new Error(res.error)
          }
        }
        const currentIds = new Set(current.map((a) => a.id))
        for (const seed of initial) {
          if (!currentIds.has(seed.id)) {
            const res = await api.scenarios.actions.create(scenarioId, {
              hook: seed.hook,
              stepId: seed.stepId,
              choiceIndex: seed.choiceIndex,
              actionType: seed.actionType,
              config: seed.config ?? {},
              condition: seed.condition ?? null,
              repeatOnRefire: seed.repeatOnRefire,
              sortOrder: seed.sortOrder,
            })
            if (!res.success) throw new Error(res.error)
          } else {
            const res = await api.scenarios.actions.update(scenarioId, seed.id, {
              config: seed.config,
              condition: seed.condition ?? null,
              repeatOnRefire: seed.repeatOnRefire,
              sortOrder: seed.sortOrder,
            })
            if (!res.success) throw new Error(res.error)
          }
        }
        const fresh = await refresh()
        if (!await saveDraftSnapshot(fresh)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
        onChanged?.()
        onClose()
      } catch (restoreError) {
        setError(
          describeSaveFailure(restoreError),
        )
      } finally {
        setCancelling(false)
      }
    })
  }

  const actionChoices: ActionChoice<{ kind: (typeof ACTION_KINDS)[number]; config: unknown }>[] = ACTION_KINDS
    .filter(kind => kind.type !== 'common_var' && (!kind.feature || actionFeatureVisibility.enabled(kind.feature)))
    .map(kind => {
      const target = kind.type === 'tag' ? { items: tags, key: 'tagIds', title: 'タグ', multiple: true }
        : kind.type === 'support_mark' ? { items: marks, key: 'markId', title: '対応マーク' }
        : kind.type === 'friend_field' ? { items: fields, key: 'fieldId', title: '友だち情報欄' }
        : kind.type === 'scenario' ? { items: scenarioOpts, key: 'scenarioId', title: 'シナリオ' }
        : kind.type === 'send_template' ? { items: templates, key: 'templateId', title: 'テンプレート' }
        : kind.type === 'reminder' ? { items: reminders, key: 'reminderId', title: 'リマインダ' }
        : kind.type === 'event_booking' ? { items: events, key: 'eventId', title: 'イベント' } : null
      return { id: kind.type, label: kind.label, icon: kind.icon, make: () => ({ kind, config: kind.make() }),
        picker: target ? { title: `${target.title}を選ぶ`, items: target.items, multiple: target.multiple,
          apply: (item, ids) => ({ ...item, config: { ...(item.config as object), [target.key]: target.multiple ? ids : ids[0] } }) } : undefined }
    })
  const reorder = useReorder({ items: actions, idOf: action => action.id, onReorder: ({ ids }) => {
    const next = ids.map(id => actionsRef.current.find(action => action.id === id)!)
    setActionsSync(next)
    void enqueue(async () => {
      for (const [index, action] of next.entries()) {
        const res = await api.scenarios.actions.update(scenarioId, action.id, { sortOrder: index })
        if (!res.success) throw new Error(res.error)
      }
      const fresh = await refresh()
      if (!await saveDraftSnapshot(fresh)) throw new Error(errorRef.current || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。')
      onChanged?.()
    })
  } })

  const editing = actions.find((a) => a.id === conditionFor) ?? null

  return (
    <InlineSettings open title={title } onClose={closeWhenSaved}>
      <div data-design-node="hz9ti">
        {/* ① 見出しと説明。設計は見出し20/700・説明13。 */}
        <div className="border-hairline flex flex-wrap items-start justify-between gap-3 border-b px-6" style={{ paddingBlock: 18 }}>
          <div className="min-w-0">
            <h2 id="action-editor-title" className="text-ink text-title font-bold">送信後のアクションを設定</h2>
            <p className="text-ink-secondary mt-1 text-label leading-relaxed">
              外部サービスの8動作をすべて扱い、条件分岐と実行順をこの画面だけで組み立てます。
            </p>
            <p className="hidden">{title}に実行する動作を決めます。上から順に実行します。</p>
          </div>
          <CloseButton onClick={closeWhenSaved} />
        </div>

        {pendingCount > 0 && <p role="status">保存しています…</p>}
        {error && <Button onClick={() => { const retry = retryRef.current; setError(''); if (retry) void enqueue(retry, true); else setReload(value => value + 1) }}>もう一度試す</Button>}
        {editing ? (
          <div className="flex-1 px-6 pb-5 pt-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-ink text-sm font-bold">
                {actions.indexOf(editing) + 1}. [{KIND_LABEL[editing.actionType]}] の条件設定
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="secondary" className="text-ink-secondary h-9 px-4 whitespace-normal" type="button" onClick={() => conditionGuard.guarded(() => setConditionFor(null))}>
                  戻る
                </Button>
                <Button variant="primary" onClick={saveCondition} disabled={conditionSaving} busy={conditionSaving}>条件を保存する
                </Button>
              </div>
            </div>
            <p className="text-ink-secondary mb-4 text-xs">
              ここで決めた条件に合う友だちにだけ、この動作を実行します。条件なしなら全員に実行します。
            </p>
            {conditionError && (
              <Notice tone="warn" className="mb-4">
                {conditionError}
              </Notice>
            )}
            {/*
              R243: 編集中の未完成行は下書きとして保持し、保存のときだけ
              不足を案内する。入力のたびに取り除かない。
            */}
            <ConditionBuilder value={conditionDraft} onChange={setConditionDraft} />
          </div>
        ) : (
          <div className="flex-1 px-6 pb-5 pt-0">
            {error && (
              <Notice tone="danger" className="mb-4">
                {error}
              </Notice>
            )}
            {/* R242: 保存方式と取消結果を目に見える形で示す。 */}
            <p className="text-ink-secondary mb-4 text-xs">
              追加・変更・削除はその場で保存されます。キャンセルは開いたときの状態に戻します。
            </p>
            {loading || !draftReady ? (
              <p className="text-ink-faint py-8 text-center text-sm">読み込んでいます</p>
            ) : (
              <div className="space-y-4">
                {/*
                  R240: 実際の種別と順序から組み立てる。0件は未設定と出す。
                  並べ替えで変わるのは順序番号だけ。
                  R241: 保存済みセットの検索・保存・呼出しの口は無いので、
                  呼出し操作と保存名の入力は置かない（置くと保存できる
                  ように見えて設定済みだと誤認させる）。
                */}
                <section className="bg-canvas-sunken rounded-control px-4 py-5">
                  <p className="text-ink text-sm font-bold">現在の送信後アクション</p>
                  <p className="text-ink-secondary mt-2 text-sm">
                    {actions.length === 0
                      ? '未設定'
                      : actions
                          .map((action, index) => `${index + 1}. ${KIND_LABEL[action.actionType]}`)
                          .join(' → ')}
                  </p>
                </section>
                {/*
                  ③ 追加する動作を選ぶ。設計は一覧より前。
                  1つも無いときに「次に何をするか」が画面の一番下にあると、
                  空の枠だけを見て手が止まる。
                */}
                <section>
                  <h3 className="text-ink text-sm font-bold">追加する動作を選ぶ</h3>
                  <p className="sr-only">
                    選ぶと、下の「実行する動作」の最後に足します。中身はあとから決められます。
                  </p>
                  {/* 設計は4×2。実装が持つ種別は5つなので、押せない札は並べない。 */}
                  <ActionAddButton choices={actionChoices} disabled={pendingCount > 0 || targetsLoading} onAdd={item => add(item.kind, item.config)} />
                  <p className="sr-only">
                    {draftSaving
                      ? 'V6下書きへ保存しています…'
                      : `変更時にV6下書きへ保存${draftVersion > 0 ? `・版${draftVersion}` : ''}`}
                  </p>
                </section>

                {/* ④ 実行する動作。並び順がそのまま実行順。 */}
                <section>
                  <h3 className="text-ink text-sm font-bold">実行する動作（上から順に実行）</h3>
                  <p className="sr-only">
                    「発動2回目以降も実行する」は動作ごとに決めます。同じ友だちが2回目に通ったとき、
                    タグは付け直しても、加算はもう一度足したくない、といった使い分けができます。
                  </p>
                  <div className="mt-1 space-y-2">
                    {reorder.shown.map((action, index) => <ActionRow key={action.id} number={index + 1} kind={KIND_LABEL[action.actionType]} title={describeAction(action, lookups)}
                      icon={ACTION_KINDS.find(kind => kind.type === action.actionType)?.icon} open={expandedId === action.id} onToggle={() => setExpandedId(expandedId === action.id ? null : action.id)}
                      rowProps={reorder.rowProps(action.id)} handle={<ActionDragHandle label={`${index + 1}つ目の行うこと`} ariaLabel={`${index + 1}つ目の行うことを並べ替える`} {...reorder.handle(action.id)} {...reorder.handleProps(action.id)} />}
                      menuItems={reorder.menuItems(action.id)} onRemove={() => remove(action)} extra={<>
                        {action.complete === false ? <span className="text-warning text-xs">未完成</span> : null}
                        <Button onClick={() => openCondition(action)}>{action.condition ? '条件ON' : '条件OFF'}</Button>
                      </>}>
                      <ActionConfigEditor action={action} accountId={selectedAccountId} tags={tags} fields={fields} marks={marks} scenarios={scenarioOpts} vars={vars} templates={templates} reminders={reminders} events={events} targetsLoading={targetsLoading} onChange={config => save(action, { config })} />
                      <SaveErrorField names={[`actions.${index}.repeatOnRefire`,`actions.${index}.repeat_on_refire`,"repeatOnRefire","action.repeatOnRefire","repeat_on_refire","action.repeat_on_refire"]}><ToggleField checked={action.repeatOnRefire} onChange={checked => save(action, { repeatOnRefire: checked })}>発動2回目以降も実行する</ToggleField></SaveErrorField>
                    </ActionRow>)}
                    {actions.length === 0 && (
                      <p className="text-ink-faint rounded-card border-hairline border border-dashed py-8 text-center text-sm">
                        まだ動作がありません。「行うことを足す」から足してください。
                      </p>
                    )}
                  </div>
                </section>
                <p className="text-ink-faint text-xs">各動作の「条件ON」から15軸の条件ビルダーを開き、分岐できます。</p>
              </div>
            )}
          </div>
        )}
        {/* R242: キャンセルは開く前の値に戻して閉じる。反映は今の内容のまま閉じる。 */}
        {!editing && <div className="border-hairline flex justify-end gap-2 border-t px-6 py-4"><Button onClick={cancel} disabled={cancelling} busy={cancelling} busyLabel="戻しています…">キャンセル</Button><Button variant="primary" disabled={pendingCount > 0 || Boolean(error) || loading || !draftReady} onClick={closeWhenSaved}>このアクションを反映</Button></div>}
      </div>
      <UnsavedLeaveDialog subject="動作の条件への変更" open={conditionGuard.leaveTarget !== null} busy={conditionSaving} onConfirm={conditionGuard.confirmLeave} onCancel={conditionGuard.cancelLeave} />
    </InlineSettings>
  )
}

const inputClass = 'border-hairline rounded-control text-ink h-9 border px-3 text-sm min-w-0 flex-1'

/**
 * アクション1つぶんの中身を編集する。
 *
 * 値と onChange だけで動く。シナリオ（scenario_actions の行）からも、
 * 自動応答（actions_json）からも同じものを使う。**中身の編集を2つ持つと、
 * 種別を足したときに片方だけ増える。**
 */
/*
 * R245: テンプレート・リマインダ・イベント予約の対象は、アカウントで絞った
 * 候補から名前で選ぶ。IDの直入力では運用者が選べず、内容も確かめられない。
 */
/** 作ってあるものを選ぶ欄（共通の選ぶ窓・dJZ7Q）。保存する値は今と同じ ID。 */
function TargetSelector({
  label,
  kind,
  kindName,
  value,
  options,
  loading,
  onChange,
}: {
  /** 欄の名前（読み上げ用）。 */
  label: string
  kind: EntityKind
  /** 「選べる○○がありません」の○○。 */
  kindName: string
  value: string
  options: ActionTargetOption[]
  loading: boolean
  onChange: (value: string) => void
}) {
  const missing = !loading && value !== '' && !options.some((o) => o.id === value)
  return (
    <div className="min-w-0 flex-1">
      <SaveErrorField names={["value"]}><EntityKindField kind={kind} label={label} options={options} meta={(row) => (row as ActionTargetOption).hint ?? undefined} value={value} onChange={onChange} /></SaveErrorField>
      {!loading && options.length === 0 && !missing && (
        <p className="text-ink-secondary mt-1.5 text-xs">選べる{kindName}がありません。</p>
      )}
      {missing && (
        <p className="text-warning mt-1.5 text-xs">
          保存されている対象はこのアカウントの候補にありません（別アカウント・削除済みの可能性）。選び直すと上書きされます。
        </p>
      )}
    </div>
  )
}

export function ActionConfigEditor({
  action,
  accountId,
  tags,
  fields,
  marks,
  scenarios,
  vars,
  templates = [],
  reminders = [],
  events = [],
  targetsLoading = false,
  onChange,
}: {
  action: ScenarioAction
  accountId?: string | null
  tags: Option[]
  fields: Option[]
  marks: Option[]
  scenarios: Option[]
  vars: { varKey: string; name: string }[]
  templates?: ActionTargetOption[]
  reminders?: ActionTargetOption[]
  events?: ActionTargetOption[]
  targetsLoading?: boolean
  onChange: (config: unknown) => void
}) {
  const c = (action.config ?? {}) as Record<string, unknown>
  const [eventSlots, setEventSlots] = useState<Array<{ id: string; starts_at: string }>>([])
  const [eventSlotsLoading, setEventSlotsLoading] = useState(false)
  const [eventSlotsFailed, setEventSlotsFailed] = useState(false)
  const eventId = typeof c.eventId === 'string' ? c.eventId : ''

  useEffect(() => {
    let cancelled = false
    setEventSlots([])
    setEventSlotsFailed(false)
    setEventSlotsLoading(Boolean(accountId && eventId))
    if (!accountId || !eventId) return
    void eventsApi.listSlots(accountId, eventId).then(({ items }) => {
      if (!cancelled) setEventSlots(items.filter((slot) => slot.is_active === 1).map((slot) => ({ id: slot.id, starts_at: slot.starts_at })))
    }).catch(() => {
      if (!cancelled) { setEventSlots([]); setEventSlotsFailed(true) }
    }).finally(() => {
      if (!cancelled) setEventSlotsLoading(false)
    })
    return () => { cancelled = true }
  }, [accountId, eventId])

  switch (action.actionType) {
    case 'tag': {
      const selected = Array.isArray(c.tagIds) ? (c.tagIds as string[]) : []
      return (
        <>
          <RadioCardGroup legend="タグの操作" className="flex flex-wrap items-center gap-4">
            {(['add', 'remove'] as const).map((op) => (
              <RadioCard
                key={op}
                name="tag-op"
                value={op}
                checked={(c.op ?? 'add') === op}
                onChange={() => onChange({ ...c, op })}
                title={op === 'add' ? 'タグを追加' : 'タグをはずす'}
              />
            ))}
          </RadioCardGroup>
          <EntityKindField kind="tag" label="タグ" multiple value={selected} options={tags} onChange={tagIds => onChange({ ...c, tagIds })} />
        </>
      )
    }

    case 'friend_field':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <SaveErrorField names={["fieldId","c.fieldId","field_id","c.field_id"]}><EntityPickerField label="友だち情報の項目" noun="友だち情報欄" items={fields} value={String(c.fieldId ?? '')} onChange={fieldId => onChange({ ...c, fieldId })} /></SaveErrorField>
          <span className="text-ink-secondary text-sm">に</span>
          {c.op !== 'clear' && (
            <SaveErrorField names={["value","c.value"]}><SharedTextField
              value={String(c.value ?? '')}
              onChange={(e) => onChange({ ...c, value: e.target.value })}
              className={inputClass}
            /></SaveErrorField>
          )}
          <span className="text-ink-secondary text-sm">を</span>
          <SaveErrorField names={["op","c.op"]}><Select
            aria-label="友だち情報の操作"
            value={String(c.op ?? 'set')}
            onChange={(value) => onChange({ ...c, op: value })}
            options={[
              { value: 'set', label: '←（代入）' },
              { value: 'add', label: '＋（加算）' },
              { value: 'sub', label: '－（減算）' },
              { value: 'clear', label: 'X（消去）' },
            ]}
          /></SaveErrorField>
          <span className="text-ink-secondary text-sm">する</span>
        </div>
      )

    case 'support_mark':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink text-sm font-semibold">対応マーク</span>
          <SaveErrorField names={["markId","c.markId","mark_id","c.mark_id"]}><EntitySelect
            aria-label="対応マーク"
            value={String(c.markId ?? '')}
            onChange={(value) => onChange({ ...c, markId: value || null })}
            options={[
              { value: '', label: 'マークを外す' },
              ...marks.map((m) => ({ ...entityOptionMetadata(m), value: m.id, label: m.name })),
            ]}
          /></SaveErrorField>
        </div>
      )

    case 'scenario':
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SaveErrorField names={["op","c.op"]}><Select
              aria-label="シナリオ操作"
              value={String(c.op ?? 'start')}
              onChange={(value) => onChange({ ...c, op: value })}
              options={[
                { value: 'start', label: '購読を始める' },
                { value: 'stop', label: '購読を止める' },
                { value: 'resume_previous', label: '1つ前のシナリオを再開する' },
              ]}
            /></SaveErrorField>
            {c.op !== 'resume_previous' && (
              <div className="min-w-0 flex-1">
                <SaveErrorField names={["scenarioId","c.scenarioId"]}><EntityKindField kind="scenario" label="対象のシナリオ" options={scenarios} value={String(c.scenarioId ?? '')}
                  placeholder={c.op === 'stop' ? '（このシナリオ）' : undefined} clearable={c.op === 'stop'}
                  onChange={(value) => onChange({ ...c, scenarioId: value })} /></SaveErrorField>
              </div>
            )}
          </div>
          {c.op === 'start' && (
            <div className="bg-canvas-sunken rounded-card space-y-2 px-3 py-2.5">
              <p className="text-ink text-xs font-medium">シナリオを購読する場合</p>
              <RadioCardGroup legend="シナリオを購読する場合">
                {(
                  [
                    { value: 'from_start', label: '（新規）最初から／（再開）最初から' },
                    { value: 'from_read', label: '（再開）友だちが読んだところから' },
                  ] as const
                ).map((opt) => (
                  <RadioCard
                    key={opt.value}
                    name="scenario-restart"
                    value={opt.value}
                    checked={(c.restart ?? 'from_start') === opt.value}
                    onChange={() => onChange({ ...c, restart: opt.value })}
                    title={opt.label}
                  />
                ))}
              </RadioCardGroup>
              <SaveErrorField names={["rememberPrevious","c.rememberPrevious","remember_previous","c.remember_previous"]}><ToggleField
                checked={c.rememberPrevious === true}
                onChange={(checked) => onChange({ ...c, rememberPrevious: checked })}
              >
                いま読んでいるシナリオを控えて、あとで「1つ前のシナリオを再開」で戻せるようにする
              </ToggleField></SaveErrorField>
            </div>
          )}
        </div>
      )

    case 'common_var':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <SaveErrorField names={["varKey","c.varKey","var_key","c.var_key"]}><EntitySelect
            aria-label="共通情報"
            value={String(c.varKey ?? '')}
            onChange={(value) => onChange({ ...c, varKey: value })}
            options={[
              { value: '', label: '共通情報を選ぶ' },
              ...vars.map((v) => ({ ...entityOptionMetadata(v), value: v.varKey, label: v.name })),
            ]}
          /></SaveErrorField>
          <span className="text-ink-secondary text-sm">に</span>
          <SaveErrorField names={["value","c.value"]}><SharedTextField
            value={String(c.value ?? '')}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
            className={inputClass}
          /></SaveErrorField>
          <span className="text-ink-secondary text-sm">を</span>
          <SaveErrorField names={["op","c.op"]}><Select
            aria-label="共通情報の操作"
            value={String(c.op ?? 'add')}
            onChange={(value) => onChange({ ...c, op: value })}
            options={[
              { value: 'add', label: '＋（加算）' },
              { value: 'sub', label: '－（減算）' },
            ]}
          /></SaveErrorField>
          <span className="text-ink-secondary text-sm">する</span>
        </div>
      )

    case 'send_message':
      return <SaveErrorField names={["content","c.content"]}><SharedTextArea value={String(c.content ?? '')} onChange={(e) => onChange({ ...c, content: e.target.value })} placeholder="送信する本文" /></SaveErrorField>
    case 'send_template': {
      const templateId = typeof c.templateId === 'string' ? c.templateId : ''
      const selected = templates.find((t) => t.id === templateId)
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink text-sm font-semibold">テンプレート</span>
            <TargetSelector
              label="テンプレート"
              kind="template"
              kindName="テンプレート"
              value={templateId}
              options={templates}
              loading={targetsLoading}
              onChange={(value) => onChange({ ...c, templateId: value })}
            />
          </div>
          {selected?.excerpt && (
            <p className="text-ink-secondary text-xs">内容: {selected.excerpt}</p>
          )}
        </div>
      )
    }
    case 'reminder':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink text-sm font-semibold">リマインダ</span>
          <TargetSelector
            label="リマインダ"
            kind="reminder"
            kindName="リマインダ"
            value={typeof c.reminderId === 'string' ? c.reminderId : ''}
            options={reminders}
            loading={targetsLoading}
            onChange={(value) => onChange({ ...c, reminderId: value })}
          />
        </div>
      )
    case 'event_booking':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="イベント予約の操作"
            value={c.op === 'cancel' ? 'cancel' : 'register'}
            options={[{ value: 'register', label: 'イベントに申し込む' }, { value: 'cancel', label: '申し込みを取り消す' }]}
            onChange={(op) => onChange({ ...c, op })}/>
          <TargetSelector
            label="イベント予約"
            kind="event"
            kindName="イベント予約"
            value={typeof c.eventId === 'string' ? c.eventId : ''}
            options={events}
            loading={targetsLoading}
            onChange={(value) => onChange({ ...c, eventId: value, slotId: null })}
          />
          {eventId && (
            <EntitySelect
              aria-label="開催回"
              value={typeof c.slotId === 'string' ? c.slotId : ''}
              options={[
                { value: '', label: c.op === 'cancel' ? 'イベント全体の申込を取り消す' : '次に空いている回' },
                ...eventSlots.map((slot) => ({
                  ...entityOptionMetadata(slot),
                  value: slot.id,
                  label: new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(slot.starts_at)),
                })),
              ]}
              disabled={eventSlotsLoading || eventSlots.length === 0}
              onChange={(value) => onChange({ ...c, slotId: value || null })}
            />
          )}
          {eventSlotsLoading && <span className="text-ink-secondary text-xs" role="status">開催回を読み込み中…</span>}
          {eventId && !eventSlotsLoading && eventSlotsFailed && <span className="text-ink-secondary text-xs" role="status">開催回を読み込めませんでした</span>}
          {eventId && !eventSlotsLoading && !eventSlotsFailed && eventSlots.length === 0 && <span className="text-ink-secondary text-xs">選べる開催回がありません</span>}
        </div>
      )

    default:
      return null
  }
}
