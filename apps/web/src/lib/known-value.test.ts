import { describe, expect, it } from 'vitest'
import { knownValue } from './known-value'
import { eventWord, payloadLabel } from '@/v8/webhooks/words'
import { firstRunStageWord } from '@/v8/ops/dashboard/first-run'
import { messageTypeText } from '@/v8/templates/words'
import { testMessageKindLabel } from '@/components/scenarios/scenario-dialogs'
import { broadcastBadgeTone, broadcastBranchLabel } from '@/v8/broadcast-detail/detail'
import { approvalKindWord } from '@/v8/restaurant/approvals/approvals'
import { friendBandWord } from '@/v8/mileage/score'
import { announcementTone } from '@/v8/ops/announcements'
import { supportStageTone } from '@/v8/ops/support'
import { memberRoleWord, memberRoleTone } from '@/v8/hq/members'
import { bookingStatusWord, bookingReminderKindWord, bookingReminderStatusWord } from '@/v8/events/booking-records'
import { statusView } from '@/v8/auto-replies/runs'
import { googleHistoryKind, googleHistoryStatus } from '@/v8/restaurant/google/profile-history'
import { mcpLevelLabel, connectionState, callLabel } from '@/v8/mcp-connect/words'
import { sourceLabel } from '@/v8/tags/tags-tab'
import type { Tag } from '@/lib/api'
import type { McpConnection, McpCallKind, McpCallResult } from '@/v8/mcp-connect/api'
import { runStatusLabel, stepStatusLabel } from '@/v8/automations/runs'
import { reminderStatusView } from '@/v8/reminders/detail'
import { manualLinkStatusLabel } from '@/v8/settings/manual-links/manual-link-view'
import { supportKindWord, supportStatusTone, supportStatusWord } from '@/v8/hq/support-words'

describe('知らない状態の表示', () => {
  it('通知の種類と状態は既知の値を表示する', () => {
    expect(bookingReminderKindWord('day_before')).toBe('前日のお知らせ')
    expect(bookingReminderKindWord('hours_before')).toBe('開始前のお知らせ')
    expect(bookingReminderStatusWord('sent')).toBe('送信済み')
    expect(bookingReminderStatusWord('cancelled')).toBe('停止済み')
    expect(bookingReminderStatusWord('failed_permanent')).toBe('失敗')
  })
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s は自分で定めた項目だけを表示する', value => {
    expect(knownValue({ known: '既知' }, value, '不明')).toBe('不明')
    expect(eventWord(value)).toBe(value)
    expect(payloadLabel([value])).toBe('選んだ出来事の項目')
    expect(firstRunStageWord(value)).toBe('段を確認できません')
    expect(messageTypeText(value)).toBe('その他')
    expect(testMessageKindLabel(value)).toBe(value)
    expect(broadcastBadgeTone(value)).toBe('neutral')
    expect(broadcastBranchLabel(value)).toBe('')
    expect(approvalKindWord(value)).toBe('種類を確認できません')
    expect(friendBandWord(value)).toBe('状態を確認できません')
    expect(announcementTone(value)).toBe('neutral')
    expect(supportStageTone(value)).toBe('neutral')
    expect(memberRoleWord(value)).toBe('役割を確認できません')
    expect(memberRoleTone(value)).toBe('neutral')
    expect(bookingStatusWord(value)).toBe('状態は未取得')
    expect(bookingReminderKindWord(value)).toBe('通知')
    expect(bookingReminderStatusWord(value)).toBe('状態を確認できません')
    expect(statusView(value)).toEqual({ label: '確認中', tone: 'neutral' })
    expect(googleHistoryKind(value)).toBe('種類を確認できません')
    expect(googleHistoryStatus(value)).toEqual({ label: '状態を確認できません', tone: 'neutral' })
    expect(mcpLevelLabel(value)).toBe('権限を確認できません')
    expect(callLabel(value as McpCallKind, 'ok')).toEqual({ label: '内容を確認できません', tone: 'neutral' })
    expect(callLabel('read', value as McpCallResult)).toEqual({ label: '結果を確認できません', tone: 'neutral' })
    expect(callLabel(value as McpCallKind, 'refused')).toEqual({ label: '断った', tone: 'warning' })
    expect(connectionState({ status: value } as McpConnection)).toEqual({ label: '状態を確認できません', tone: 'neutral' })
    expect(sourceLabel({ assignSource: value } as Tag)).toBe('付け方を確認できません')
    expect(runStatusLabel(value)).toBe('状態を確認できません')
    expect(stepStatusLabel(value)).toBe('状態を確認できません')
    expect(reminderStatusView(value)).toEqual({ label: '状態を確認できません', tone: 'muted' })
    expect(manualLinkStatusLabel(value)).toBe('状態を確認できません')
    expect(supportStatusWord(value)).toBe('状態を確認できません')
    expect(supportStatusTone(value)).toBe('neutral')
    expect(supportKindWord(value, '種類不明')).toBe('種類不明')
  })
  it('既知の状態は従来の言葉を使う', () => {
    expect(eventWord('friend_add')).toBe('友だちになった')
    expect(payloadLabel(['friend_add'])).toBe('友だちの名前・タグ')
    expect(firstRunStageWord('started')).toBe('アカウントを作った')
    expect(messageTypeText('text')).toBe('テキスト')
    expect(testMessageKindLabel('image')).toBe('画像')
    expect(callLabel('read', 'ok')).toEqual({ label: '読んだ', tone: 'neutral' })
    expect(callLabel('draft', 'ok')).toEqual({ label: '下書きを作った', tone: 'info' })
    expect(callLabel('send_request', 'ok')).toEqual({ label: '送る依頼（承認待ち）', tone: 'info' })
    expect(callLabel('read', 'error')).toEqual({ label: '失敗', tone: 'danger' })
    expect(callLabel('read', 'rate_limited')).toEqual({ label: '回数の上限', tone: 'warning' })
    expect(runStatusLabel('succeeded')).toBe('動いた')
    expect(stepStatusLabel('success')).toBe('成功')
    expect(reminderStatusView('succeeded')).toEqual({ label: '送れた', tone: 'ok' })
    expect(manualLinkStatusLabel('ok')).toBe('開けます')
    expect(supportStatusWord('answered')).toBe('回答済み')
    expect(supportStatusTone('open')).toBe('warning')
  })
})
