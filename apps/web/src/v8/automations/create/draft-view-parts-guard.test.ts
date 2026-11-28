import { describe, expect, it } from 'vitest'
import { actionRowTitle } from './draft-view-parts'

describe('actionRowTitle guards', () => {
  it('returns canonical labels for non-draft action types instead of mislabeling them as send_message', () => {
    expect(actionRowTitle('remove_tag')).toBe('タグを外す')
    expect(actionRowTitle('send_webhook')).toBe('外部連携へ送信')
    expect(actionRowTitle('switch_rich_menu')).toBe('メニューを切り替え')
  })

  it('returns a safe neutral fallback for unknown, blank, or Object.prototype action types', () => {
    expect(actionRowTitle('unknown_future_action')).toBe('登録した処理')
    expect(actionRowTitle('')).toBe('登録した処理')
    expect(actionRowTitle('toString')).toBe('登録した処理')
    expect(actionRowTitle('constructor')).toBe('登録した処理')
    expect(actionRowTitle(null as unknown as string)).toBe('登録した処理')
  })

  it('preserves draft-native action labels', () => {
    expect(actionRowTitle('add_tag')).toBe('タグを付ける')
    expect(actionRowTitle('start_scenario')).toBe('シナリオを始める')
    expect(actionRowTitle('common_action')).toBe('共通アクションを実行')
    expect(actionRowTitle('notify_staff')).toBe('担当へ知らせる')
    expect(actionRowTitle('wait')).toBe('待つ')
    expect(actionRowTitle('send_message')).toBe('メッセージを送る')
  })
})
