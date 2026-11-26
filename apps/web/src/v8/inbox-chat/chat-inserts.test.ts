import { describe, expect, it } from 'vitest'
import { CHAT_INSERT_TOKENS, unresolvedNoticeText, unresolvedSendFailureText, withoutRawInserts } from './chat-inserts'

describe('入らない差し込みの知らせ（何が・なぜ・どうすれば）', () => {
  it('予約の差し込みは「予約が無い」と言い切らず、予約情報から取れないと言う', () => {
    const text = unresolvedNoticeText(['var.guest_count'], { vars: {}, varsComplete: true }, 'insert')
    expect(text).toBe('「人数」はこの方の予約情報から値を取得できないため入りません。このまま入力欄に入れられますが、送る前にその部分を書き換えるか消してください。')
  })

  it('登録のある共通情報は理由を言い切らず、登録の無いもの・置き換えられない形と分けて言う', () => {
    const text = unresolvedNoticeText(['var.hours', 'var.closure_datetime', 'pet', 'var.hours'], { vars: { hours: '営業時間' }, varsComplete: true }, 'compose')
    expect(text).toBe('「営業時間」は共通情報の値を取得できないため、「休業の日時」は共通情報に登録が無いため、「不明な差し込み」は送るときに置き換えられない形のため入りません。送る前にその部分を書き換えるか消してください（このままでは送れません）。')
  })

  it('共通情報の一覧を読み込み中は、登録が無いとは言わない', () => {
    expect(unresolvedNoticeText(['var.opening_note'], { vars: {} }, 'compose')).toContain('「共通情報」は入る値が見つからないため')
  })

  it('まとめて送るときは外すテンプレートの名前を添え、入れる時は見ているものと違えば名前を添える', () => {
    expect(unresolvedNoticeText(['var.closure_datetime'], {}, 'pack', ['臨時休業'])).toContain('続けて送ると送信が止まるため、「臨時休業」を外すか、1通ずつ入力欄で直してください。')
    expect(unresolvedNoticeText(['var.closure_datetime'], {}, 'insert', ['臨時休業'])).toContain('「臨時休業」はこのまま入力欄に入れられますが')
    expect(unresolvedNoticeText([], {}, 'insert')).toBe('')
  })

  it('文に生の記号を出さない', () => {
    for (const context of ['insert', 'pack', 'compose'] as const) {
      expect(unresolvedNoticeText(['var.reservation_datetime', 'var.x', 'weird thing'], {}, context)).not.toContain('{{')
    }
  })
})

describe('送信口が止めた時の文', () => {
  it('名前が分かれば札の名前、無ければ記号を出さずに直し方を言う', () => {
    expect(unresolvedSendFailureText(['var.course_name'])).toBe('「コース名」が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
    expect(unresolvedSendFailureText([])).toBe('差し込みの値が入らないため、送りませんでした。その部分を書き換えるか消してから、送り直してください。')
  })

  it('口の失敗文に記号が混ざっても、受信箱の名前で置き換えて見せる', () => {
    expect(withoutRawInserts('差し込みを解決できません: {{var.closure_datetime}}, {{pet}}', { vars: { closure_datetime: '臨時休業の日時' } }))
      .toBe('差し込みを解決できません: ［臨時休業の日時］, ［不明な差し込み］')
    expect(withoutRawInserts('送信できませんでした')).toBe('送信できませんでした')
  })

  it('トークの予約の札は共通の名前を使い、説明だけトークの意味にする', () => {
    expect(CHAT_INSERT_TOKENS.map(spec => [spec.token, spec.label, spec.icon])).toEqual([
      ['{{var.reservation_datetime}}', '予約の日時', 'braces'],
      ['{{var.course_name}}', 'コース名', 'braces'],
      ['{{var.guest_count}}', '人数', 'braces'],
    ])
    expect(CHAT_INSERT_TOKENS.every(spec => spec.hint.includes('予約情報から取得できないときは入りません'))).toBe(true)
  })
})
