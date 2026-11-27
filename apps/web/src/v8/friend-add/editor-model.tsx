'use client'

import { type FriendAddRule,type FriendAddRuleDefinition,type FriendAddRuleKind,type FriendAddRuleStatus } from '@/lib/api';
import { requiredText } from '@/lib/form-requirement';


export const b244Requirements = {
  rule_name: requiredText("設定名を入力してください。"),
}

/*
 * ★V8 友だち追加時の配信を作る・直す（Pencil：作る①基本設定  → ②流入リンク
 * （1152 ）→ ③初回案内  → ④あわせて行うこと  → ⑤確認 、
 * 編集の競合 ）。
 *
 * 型（CreatePage）に、戻る・題・手順の輪・説明・左の段（カード）・右の「設定内容」と
 * LINEでの見え方・下に追従する帯（キャンセル・下書きを保存・次へ）を渡す。
 *
 * 読み・保存・テスト・離脱の番兵は app/friend-add-settings/editor-v8.tsx と同じ
 * （口・版・下書き・冪等の鍵の扱いを変えない）。違うのは見せ方と、先に保存された
 * ときの帯（違いを比べる・最新を読み込んで続ける）。BEHAVIOR.md に書き出した。
 */
export type Step = 'basic' | 'routes' | 'message' | 'actions' | 'preview'

export type EditorRule = {
  name: string
  folderName: string | null
  priority: number
  friendKind: FriendAddRuleKind
  isFallback: boolean
  status: FriendAddRuleStatus
  matchedLast7Days: number | null
  lastTestStatus: string | null
  version: number
}

/** 流入リンクを使っているほかの設定（「いま〇〇（順番N）が動いています」）。 */
export type RouteUse = { ruleId: string; name: string; priority: number }

export const MESSAGE_LIMIT = 5000

/* 手順の輪の文言は板どおり。 */
export const STEPS: Array<{ key: Step; label: string; node: string }> = [
  { key: 'basic', label: '基本設定', node: 'wDzkc' },
  { key: 'routes', label: '流入リンク', node: 'h8uNW' },
  { key: 'message', label: '初回案内', node: 'al47K' },
  { key: 'actions', label: 'あわせて行うこと', node: 'i1nThZ' },
  { key: 'preview', label: '確認', node: 'U8Xm3X' },
]

export const EMPTY_RULE: EditorRule = {
  name: '', folderName: null, priority: 1, friendKind: 'first_time', isFallback: false,
  status: 'draft', matchedLast7Days: null, lastTestStatus: null, version: 0,
}

export const EMPTY_DEFINITION: FriendAddRuleDefinition = {
  routeIds: [],
  scenarioId: null,
  messageType: 'text',
  messageText: '',
  timing: 'immediate',
  actions: [],
  friendCondition: '',
  internalMemo: '',
  activeFrom: null,
  activeUntil: null,
  deliveryChoices: { sendWelcomeMessage: true, startScenario: true, runActions: true },
  resendSuppressionHours: 24,
  startPosition: 'beginning',
  unknownRouteAction: { sendCommonGuidance: true, notifyStaff: false },
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  timeWindows: [{ start: '08:00', end: '21:00' }],
}

/** 保存済みかの比較には版番号を含めない（管理画面 の編集器と同じ）。 */
export function editorSnapshot(rule: EditorRule, definition: FriendAddRuleDefinition) {
  return JSON.stringify({
    name: rule.name,
    folderName: rule.folderName,
    priority: rule.priority,
    friendKind: rule.friendKind,
    isFallback: rule.isFallback,
    definition,
  })
}

export function toEditorRule(rule: FriendAddRule): EditorRule {
  return {
    name: rule.name,
    folderName: rule.folderName,
    priority: rule.priority,
    friendKind: rule.friendKind,
    isFallback: rule.isFallback,
    status: rule.status,
    matchedLast7Days: rule.matchedLast7Days,
    lastTestStatus: rule.lastTestStatus,
    version: rule.version,
  }
}


import { type SegmentCondition } from '@/lib/segment-condition';
function isFriendCondition(value: unknown): value is SegmentCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const condition = value as Record<string, unknown>
  if (condition.operator !== 'AND' && condition.operator !== 'OR') return false
  if (!Array.isArray(condition.rules) || !condition.rules.every(rule => rule && typeof rule === 'object' && !Array.isArray(rule) && typeof rule.type === 'string' && 'value' in rule)) return false
  return condition.groups === undefined || (Array.isArray(condition.groups) && condition.groups.every(isFriendCondition))
}
export function parseFriendConditionJson(value: string): SegmentCondition | null {
  const raw = value.trim()
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isFriendCondition(parsed) ? parsed : null
  } catch {
    return null
  }
}
