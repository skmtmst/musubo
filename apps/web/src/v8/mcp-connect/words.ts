import { knownValue } from '@/lib/known-value'
/*
 * G9 の言葉と権限（要件 G9 §2-2・§2-5・§2-6）。
 * 権限の言い方は 3 段にそろえる：読むだけ／読む＋下書きを作る／読む＋下書き＋送る依頼。
 * 使わない言葉：「MCP」（区画の「？」の中だけ）・「スコープ」・「トークン」（「鍵」）。
 */
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import type { McpCallKind, McpCallResult, McpConnection, McpLevel } from './api'

export const LEVEL_LABEL: Record<McpLevel, string> = {
  read: '読むだけ',
  draft: '読む＋下書きを作る',
  send_request: '読む＋下書き＋送る依頼',
}

export const mcpLevelLabel = (level: string): string => knownValue(LEVEL_LABEL, level, '権限を確認できません')

export const LEVEL_NOTE: Record<McpLevel, string> = {
  read: '数・配信の結果・予約の件数を読む',
  draft: '配信・テンプレートの下書きまで',
  send_request: '必ず人の承認待ちに入る',
}

export const EXPIRY_OPTIONS = [
  { value: '30', label: '期限：30 日' },
  { value: '90', label: '期限：90 日' },
  { value: '180', label: '期限：180 日' },
  { value: '365', label: '期限：365 日' },
]

export function connectionState(connection: McpConnection): { label: string; tone: StatusBadgeTone } {
  if (connection.status === 'stopped') return { label: '止めた', tone: 'neutral' }
  if (connection.status === 'expired') return { label: '期限切れ', tone: 'danger' }
  if (connection.status !== 'active') return { label: '状態を確認できません', tone: 'neutral' }
  if (connection.previousKeyExpiresAt) return { label: '鍵の作り直し中', tone: 'warning' }
  return { label: '使える', tone: 'success' }
}

/** 記録の「したこと」。範囲外の呼び出しは「断った」。 */
export function callLabel(kind: McpCallKind, result: McpCallResult): { label: string; tone: StatusBadgeTone } {
  if (result === 'refused') return { label: '断った', tone: 'warning' }
  if (result === 'rate_limited') return { label: '回数の上限', tone: 'warning' }
  if (result === 'error') return { label: '失敗', tone: 'danger' }
  if (result !== 'ok') return { label: '結果を確認できません', tone: 'neutral' }
  if (kind === 'draft') return { label: '下書きを作った', tone: 'info' }
  if (kind === 'send_request') return { label: '送る依頼（承認待ち）', tone: 'info' }
  if (kind === 'read') return { label: '読んだ', tone: 'neutral' }
  return { label: '内容を確認できません', tone: 'neutral' }
}

export const CALL_FILTER_OPTIONS = [
  { value: '', label: 'したこと：すべて' },
  { value: 'read', label: '読んだ' },
  { value: 'draft', label: '下書きを作った' },
  { value: 'send_request', label: '送る依頼（承認待ち）' },
  { value: 'refused', label: '断った' },
  { value: 'error', label: '失敗' },
]

export interface McpPermissions {
  /** 区画を出す（スタッフは出さない）。 */
  see: boolean
  /** 接続を作る・鍵を作り直す（オーナーだけ・代理ログインは不可）。 */
  create: boolean
  /** 止める（オーナー・管理者・代理ログインの緊急停止）。 */
  stop: boolean
  viewer: boolean
}

export function mcpPermissions(role: string | null, impersonating: boolean): McpPermissions {
  if (role === null || role === 'staff') return { see: false, create: false, stop: false, viewer: false }
  if (role === 'viewer') return { see: true, create: false, stop: false, viewer: true }
  if (impersonating) return { see: true, create: false, stop: true, viewer: false }
  return { see: true, create: role === 'owner', stop: role === 'owner' || role === 'admin', viewer: false }
}
