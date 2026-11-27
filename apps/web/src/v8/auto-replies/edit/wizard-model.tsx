'use client'

import {
WEEKDAY_LABELS,
emptyKeywordRule,
initialMatchType,
newActionKey,
readInlineActions,
readKeywordRules,
type HolidayRuleValue,
type InlineAction,
type KeywordRuleDraft
} from '@/components/auto-replies/draft-fields';
import Button from '@/components/shared/button';
import { type SegmentCondition } from '@/lib/segment-condition';
import type {
AutoReplyDraftInput
} from '@line-crm/shared';
import {
File,
Image as ImageIcon,
MapPin,
Mic,
MousePointerClick,
Sticker,
Type,
Video
} from 'lucide-react';
import type * as React from 'react';
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css';


/*
 * ★V8 自動応答の作成・編集・有効化。
 *
 * Pencil の正本：①基本設定  ②どんなときに動くか
 * ③何を返すか  ④優先順位  ⑤確認 、完了 。
 *
 * 一覧から「作る」で入ると下書きとして作り、最後の「確認」で
 * 有効にする。公開の確かめ（重なり・試し送り・公開前チェック）は
 * 手順4・5の中に畳み込み、別画面の公開フローには分けない。
 * URL の `?step=` が手順の正本。戻る・進むは step の移動として扱い、
 * 未保存の離脱番兵が止めないよう samePage で画面内とみなす。
 */
export type WizardStep = 'basic' | 'trigger' | 'response' | 'priority' | 'confirm'

export const STEP_ORDER: WizardStep[] = ['basic', 'trigger', 'response', 'priority', 'confirm']

export const STEP_LABELS_V8: Record<WizardStep, string> = {
  basic: '基本設定',
  trigger: 'どんなときに動くか',
  response: '何を返すか',
  priority: '優先順位',
  confirm: '確認',
}

export const STEP_DESIGN_NODES: Record<WizardStep, string> = {
  basic: 'K7HWG',
  trigger: 'A0pDt',
  response: 'rfhIf',
  priority: 'Guoye',
  confirm: 'XJUqs',
}

export const DONE_DESIGN_NODE = 'V4LjH'

export type LoadState = 'loading' | 'ready' | 'error' | 'not-found' | 'published-only'

export type ResponseMode = 'silent' | 'template' | 'inline-text' | 'inline-flex' | 'inline-image'

export type InputIssue = { error: string; field?: string; step?: WizardStep }

export function detectMode(d: {
  responseType: string
  templateId: string | null
}): ResponseMode {
  if (d.responseType === 'silent') return 'silent'
  if (d.templateId) return 'template'
  if (d.responseType === 'flex') return 'inline-flex'
  if (d.responseType === 'image') return 'inline-image'
  return 'inline-text'
}

/**
 * 画面で持つ下書き。全部を1つのオブジェクトに入れて、保存済みとの差分を
 * シリアライズ比較（dirty）できるようにする。
 */
export interface WizardForm {
  ruleName: string
  folderId: string
  internalMemo: string
  respondToAll: boolean
  keywordRules: KeywordRuleDraft[]
  keywordMatchMode: 'any' | 'all'
  /** 全体に効かせる一致のしかた（行にも載せる）。 */
  matchType: 'exact' | 'contains'
  messageKinds: string[]
  weekdays: number[]
  holidayRule: HolidayRuleValue
  /** 'always' は時間帯なし。'custom' のとき activeFrom/activeUntil を使う。 */
  timeMode: 'always' | 'custom'
  activeFrom: string
  activeUntil: string
  friendTarget: 'all' | 'filtered'
  friendConditions: SegmentCondition | null
  mode: ResponseMode
  templateId: string | null
  responseContent: string
  actions: InlineAction[]
  replyDelaySeconds: string
  cooldownOn: boolean
  cooldownMinutes: string
  skipWhenOperatorActive: boolean
  oncePerFriend: boolean
  unmatchedMode: 'none' | 'notify_operator'
  receiveSources: Array<'line' | 'email'>
  /** 評価順。手順4の「上へ」だけが変える。 */
  priority: number
}

export const EMPTY_FORM: WizardForm = {
  ruleName: '',
  folderId: '',
  internalMemo: '',
  respondToAll: false,
  keywordRules: [emptyKeywordRule()],
  keywordMatchMode: 'any',
  matchType: 'exact',
  messageKinds: [],
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  holidayRule: 'ignore',
  timeMode: 'always',
  activeFrom: '',
  activeUntil: '',
  friendTarget: 'all',
  friendConditions: null,
  mode: 'inline-text',
  templateId: null,
  responseContent: '',
  actions: [],
  replyDelaySeconds: '0',
  cooldownOn: false,
  cooldownMinutes: '60',
  skipWhenOperatorActive: false,
  oncePerFriend: false,
  unmatchedMode: 'none',
  receiveSources: ['line'],
  priority: 0,
}

/** 保存済みの下書き・公開版の設定を画面の形へ。 */
export function formFromSettings(s: AutoReplyDraftInput): WizardForm {
  const rules = readKeywordRules({
    keyword: s.keyword,
    matchType: s.matchType,
    keywords: s.keywords,
  })
  return {
    ruleName: s.name ?? '',
    folderId: s.folderId ?? '',
    internalMemo: s.internalMemo ?? '',
    respondToAll: s.respondToAll,
    keywordRules: rules,
    keywordMatchMode: s.keywordMatchMode ?? 'any',
    matchType: initialMatchType({ keyword: s.keyword, matchType: s.matchType, keywords: s.keywords }),
    messageKinds: s.messageKinds ?? [],
    weekdays: s.responseWeekdays?.length ? s.responseWeekdays : [0, 1, 2, 3, 4, 5, 6],
    holidayRule: (s.responseHolidayRule as HolidayRuleValue) ?? 'ignore',
    timeMode: s.activeFrom || s.activeUntil ? 'custom' : 'always',
    activeFrom: s.activeFrom ?? '',
    activeUntil: s.activeUntil ?? '',
    friendTarget: s.friendConditions ? 'filtered' : 'all',
    friendConditions: (s.friendConditions as SegmentCondition | null) ?? null,
    mode: detectMode({ responseType: s.responseType, templateId: s.templateId }),
    templateId: s.templateId,
    responseContent: s.responseContent ?? '',
    actions: readInlineActions(s.actions),
    replyDelaySeconds: s.replyDelaySeconds == null ? '0' : String(s.replyDelaySeconds),
    cooldownOn: s.cooldownMinutes != null && s.cooldownMinutes > 0,
    cooldownMinutes: s.cooldownMinutes == null ? '60' : String(s.cooldownMinutes),
    skipWhenOperatorActive: s.skipWhenOperatorActive ?? false,
    oncePerFriend: s.oncePerFriend ?? false,
    unmatchedMode: s.unmatchedAction?.type === 'notify_operator' ? 'notify_operator' : 'none',
    receiveSources: s.receiveSources?.length ? s.receiveSources : ['line'],
    priority: s.priority ?? 0,
  }
}

/**
 * 手順1「ひな形から作る」。選ぶと名前と条件の下書きまで入る。
 * `lines` は札に並べる中身の説明で、`apply` が実際に入れる内容と一致させる
 * （入れない後の処理は書かない）。
 */
export const STARTER_TEMPLATES: Array<{
  key: string
  name: string
  lines: string[]
  apply: (form: WizardForm) => WizardForm
}> = [
  {
    key: 'off-hours',
    name: '営業時間外の自動返信',
    lines: ['毎日 21:00〜09:00 に受信', 'テキストで返す', '＋担当者へ知らせる'],
    apply: (form) => ({
      ...form,
      ruleName: '営業時間外の自動返信',
      respondToAll: true,
      timeMode: 'custom',
      activeFrom: '21:00',
      activeUntil: '09:00',
      mode: 'inline-text',
      responseContent: form.responseContent || '営業時間外のため、翌営業日に担当者からご連絡します。',
      actions: [{key:newActionKey(),actionType:'notify_staff',config:{notificationRuleId:'',notificationRuleVersion:0,message:'営業時間外のお問い合わせがありました。受信箱を確認してください。'},onFailure:'continue'}],
    }),
  },
  {
    key: 'booking-change',
    name: '予約変更の受付',
    lines: ['「予約変更」「日程変更」を含む', 'テンプレートで返す', '＋担当者へ知らせる・タグを付ける'],
    apply: (form) => ({
      ...form,
      ruleName: '予約変更の受付',
      respondToAll: false, timeMode: 'always', activeFrom: '', activeUntil: '',
      actions: [{key:newActionKey(),actionType:'notify_staff',config:{notificationRuleId:'',notificationRuleVersion:0,message:'予約変更のお問い合わせがありました。受信箱を確認してください。'},onFailure:'continue'}, {key:newActionKey(),actionType:'tag',config:{op:'add',tagIds:[]},onFailure:'continue'}],
      keywordRules: [
        { keyword: '予約変更', matchType: 'contains', minLength: '', caseSensitive: true },
        { keyword: '日程変更', matchType: 'contains', minLength: '', caseSensitive: true },
      ],
      matchType: 'contains',
      keywordMatchMode: 'any',
      mode: 'template',
    }),
  },
  {
    key: 'faq',
    name: 'よくある質問への回答',
    lines: ['「営業時間」「場所」「料金」を含む', 'テンプレートで返す', '＋タグを付ける'],
    apply: (form) => ({
      ...form,
      ruleName: 'よくある質問への回答',
      respondToAll: false, timeMode: 'always', activeFrom: '', activeUntil: '',
      actions: [{key:newActionKey(),actionType:'tag',config:{op:'add',tagIds:[]},onFailure:'continue'}],
      keywordRules: [
        { keyword: '営業時間', matchType: 'contains', minLength: '', caseSensitive: true },
        { keyword: '場所', matchType: 'contains', minLength: '', caseSensitive: true },
        { keyword: '料金', matchType: 'contains', minLength: '', caseSensitive: true },
      ],
      matchType: 'contains',
      keywordMatchMode: 'any',
      mode: 'template',
    }),
  },
]

/**
 * 曜日のまとめ（：つながりは「月〜金に反応」、ばらばらは「月・水・金に反応」）。
 * 日曜はじまりの番号のまま見る。土日（[0, 6]）はつながりにせず並べる。
 */
export function weekdaySummary(days: number[]): string {
  const sorted = days.slice().sort((a, b) => a - b)
  if (sorted.length === 0 || sorted.length === 7) return '毎日反応する'
  const consecutive = sorted.length > 1
    && sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1)
  if (consecutive) {
    return `${WEEKDAY_LABELS[sorted[0]]}〜${WEEKDAY_LABELS[sorted[sorted.length - 1]]}に反応`
  }
  return `${sorted.map((day) => WEEKDAY_LABELS[day]).join('・')}に反応`
}

/** 手順④の行の2行目：そのルールの動き方（すべて／言葉・曜日・時間）。 */
export function ruleTriggerSummary(rule: { keyword?: string | null; activeFrom?: string | null; activeUntil?: string | null }): string {
  const what = rule.keyword ? `「${rule.keyword}」を含む` : 'すべてのメッセージ'
  const when = rule.activeFrom ? `毎日 ${rule.activeFrom}〜${rule.activeUntil ?? ''}` : 'いつでも'
  return `${what}・${when}`
}

/** 差し込みに使える札。本文の末尾へトークンを足す。 */
/** 絵 「反応するメッセージの種類」：絵の4つを先に並べ、ほかは「ほかの種類」で出す（機能は残す）。 */
export const MAIN_KINDS = ['テキスト', 'スタンプ', '画像', '位置情報']

export const kindOrder = (label: string) => { const i = MAIN_KINDS.indexOf(label); return i < 0 ? 99 : i }

/** 絵 「反応するメッセージの種類」の札の印。 */
export const KIND_ICONS: Record<string, typeof Type> = { テキスト: Type, スタンプ: Sticker, 画像: ImageIcon, 位置情報: MapPin, 動画: Video, 音声: Mic, ファイル: File, ボタンのタップ: MousePointerClick }

/** 「返すまで待つ時間」の選択肢。 */
export const REPLY_DELAY_OPTIONS = [
  { value: '0', label: 'すぐ返す' },
  { value: '10', label: '10秒待つ' },
  { value: '30', label: '30秒待つ' },
  { value: '60', label: '1分待つ' },
  { value: '300', label: '5分待つ' },
]

export const WEEKDAY_PRESETS: Array<{ key: string; label: string; days: number[] }> = [
  { key: 'weekday', label: '平日', days: [1, 2, 3, 4, 5] },
  { key: 'weekend', label: '土日', days: [0, 6] },
  { key: 'everyday', label: '毎日', days: [0, 1, 2, 3, 4, 5, 6] },
]

export interface RuleRow {
  id: string
  name: string
  isActive: boolean
  lifecycleStatus: string
  priority: number
  createdAt: string
  keyword: string
  activeFrom: string | null
  activeUntil: string | null
}

export function displayName(rule: { name?: string | null; keyword?: string }): string {
  return rule.name?.trim() || rule.keyword?.trim() || '名前なしの自動応答'
}

/** テストで「先に動く別ルール」が返した理由コードの読み方。 */
export const REASON_WORDS: Record<string, string> = {
  message_kind_not_matched: 'メッセージの種類が違います',
  keyword_not_matched: '言葉に当たりません',
  outside_active_window: '受け付ける時間帯の外です',
  weekday_not_allowed: 'この曜日は受け付けません',
  operator_handling: '担当者が対応中です',
  already_replied_once: 'この友だちへは一度返しています',
  cooldown_active: '前回の返信から間を空けています',
  friend_conditions_not_met: '友だちの条件に当てはまりません',
  higher_priority_won: '上のルールが先に動きます',
}

export function SummaryRow({
  label,
  onEdit,
  children,
}: {
  label: string
  onEdit: () => void
  children: React.ReactNode
}) {
  return (
    <div className={styles.summaryRow}>
      <span className={styles.summaryKey}>{label}</span>
      <span className={styles.summaryVal} title={typeof children === 'string' ? children : undefined}>{children}</span>
      <Button type="button" variant="text" onClick={onEdit}>
        変更する
      </Button>
    </div>
  )
}
