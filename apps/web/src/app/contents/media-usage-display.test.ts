import { describe, expect, it } from 'vitest'
import { UNKNOWN_USAGE_KIND, formatMediaSize, mediaUsageKindText } from './media-usage-display'

describe('登録メディアの使用箇所の言葉づかい', () => {
  it('走査が記録する7種類を運用者の言葉にする', () => {
    expect(mediaUsageKindText('template')).toBe('テンプレート')
    expect(mediaUsageKindText('broadcast')).toBe('一斉配信')
    expect(mediaUsageKindText('rich_menu')).toBe('リッチメニュー')
    expect(mediaUsageKindText('scenario_step')).toBe('シナリオのステップ')
    expect(mediaUsageKindText('nen_column')).toBe('NENコラム')
    expect(mediaUsageKindText('event')).toBe('イベント')
    expect(mediaUsageKindText('webinar')).toBe('ウェビナー')
  })

  it('一斉配信の素材も言葉にする（画面に card_message が出ていた）', () => {
    expect(mediaUsageKindText('card_message')).toBe('カードタイプ')
    expect(mediaUsageKindText('rich_message')).toBe('リッチメッセージ')
    expect(mediaUsageKindText('coupon')).toBe('クーポン')
    expect(mediaUsageKindText('research')).toBe('リサーチ')
  })

  it('回答フォームの使用は種類を判別できないと出さない', () => {
    expect(mediaUsageKindText('form')).toBe('回答フォーム')
  })

  it('表に無い種別を内部の記号のまま出さない', () => {
    expect(mediaUsageKindText('some_future_kind')).toBe(UNKNOWN_USAGE_KIND)
    expect(mediaUsageKindText('some_future_kind')).not.toContain('some_future_kind')
    expect(mediaUsageKindText('')).toBe(UNKNOWN_USAGE_KIND)
  })

  it('どの言い方にも内部の記号を含めない', () => {
    const kinds = ['template', 'broadcast', 'rich_menu', 'scenario_step', 'nen_column',
      'event', 'webinar', 'rich_message', 'card_message', 'coupon', 'research', 'unknown']
    for (const kind of kinds) {
      expect(mediaUsageKindText(kind)).not.toMatch(/[a-z]+_[a-z]+/)
    }
  })
})

describe('容量の短い表示（一覧と詳細で同じ）', () => {
  it('B・KB・MB・GBを使い分ける', () => {
    expect(formatMediaSize(512)).toBe('512 B')
    expect(formatMediaSize(2048)).toBe('2 KB')
    expect(formatMediaSize(3 * 1024 * 1024)).toBe('3.0 MB')
    // #710: 1GB超はGB表示。2048MBのような4桁MBで出さない。
    expect(formatMediaSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
    expect(formatMediaSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})
