import { describe, expect, it } from 'vitest'
import { answersForApi, answerOf, choiceLabel, needsActivation, pairStarterItems, questionsFor, recommendedValue, stepNames, summarizeSetup } from './model'

const state = {
  style: 'restaurant' as const, styleSelected: true, version: 1,
  answers: {
    image: { mode: 'configured' as const, value: 'keep' },
    approval: { mode: 'configured' as const, value: 'automatic' },
    payment: { mode: 'later' as const },
    stamps: { mode: 'later' as const },
  },
}

describe('はじめの質問の決まり（・組4の質問キー）', () => {
  it('飲食は 11 問（ が正）。質問のキーはどれも口が受け付ける', () => {
    const keys = ['image', 'booking', 'approval', 'payment', 'reminders', 'stamps', 'coupons', 'tickets', 'outcome', 'content']
    expect(stepNames('restaurant').map((step) => step.short)).toEqual(['使い方のスタイル', '見た目', '予約の確定の仕方', 'お支払い', 'キャンセルの期限', '前日のお知らせ', '来店スタンプ', 'クーポン', '席・卓', '営業時間', '受け付ける人数'])
    for (const style of ['restaurant', 'salon', 'consult', 'lesson', 'ec', 'standard'] as const) {
      for (const q of questionsFor(style)) expect([...keys, 'cancelDeadline', 'seats', 'hours', 'partySize', 'nomination', 'assignment', 'classCapacity'], q.key).toContain(q.key)
    }
    const sent = answersForApi({ approval: { mode: 'configured', value: 'automatic' }, cancelDeadline: { mode: 'configured', value: 'day_before' }, hours: { mode: 'later' } })
    expect(sent).toEqual({ approval: { mode: 'configured', value: 'automatic' }, cancelDeadline: { mode: 'configured', value: 'day_before' }, hours: { mode: 'later' }, booking: { mode: 'configured', value: true } })
  })

  it('はい・いいえの答えは真偽で、あとで・手動は mode だけで送る', () => {
    expect(answerOf('true')).toEqual({ mode: 'configured', value: true })
    expect(answerOf('false')).toEqual({ mode: 'configured', value: false })
    expect(answerOf('manual')).toEqual({ mode: 'manual' })
    expect(answerOf('later')).toEqual({ mode: 'later' })
    expect(answerOf('automatic')).toEqual({ mode: 'configured', value: 'automatic' })
  })

  it('おすすめは業種ごとに先に選び、題に「（おすすめ）」を付ける', () => {
    const approval = questionsFor('consult').find((q) => q.key === 'approval')!
    expect(recommendedValue(approval, 'consult')).toBe('require_approval')
    expect(answerOf('require_approval', approval)).toEqual({ mode: 'configured', value: 'manual' })
    expect(answerOf('manual', approval)).toEqual({ mode: 'manual' })
    expect(choiceLabel(approval, approval.choices[1], 'consult')).toBe('担当が承認してから確定する（おすすめ）')
  })
})

describe('入った物の突き合わせ', () => {
  it('item_key が無いので種類ごとに並びで名前を付け、止めた予約メニュー・下書きのお知らせを動かす対象にする', () => {
    const pairs = pairStarterItems(
      [{ key: 'a', kind: 'automation', name: '前日のお知らせ' }, { key: 'm', kind: 'booking_menu', name: 'ランチ' }],
      [{ target_id: 'x', kind: 'booking_menu', is_sample: 1, status: 'inactive', draftRevision: null }, { target_id: 'y', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: 'd1' }],
    )
    expect(pairs.map((pair) => [pair.state.target_id, pair.item.name])).toEqual([['x', 'ランチ'], ['y', '前日のお知らせ']])
    expect(pairs.every((pair) => needsActivation(pair.state))).toBe(true)
  })
})

describe('はじめにやること（Bdfxm）', () => {
  it('警告・あとで・止めている物・見本の画像を 1 行ずつ。警告と同じ機能の「あとで」は重ねない', () => {
    const summary = summarizeSetup(
      state,
      [{ feature: 'stamps', areaId: 'E', groupId: 'g', href: '/visit-stamps', customerState: 'preparing' }],
      [{ target_id: 'a1', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: 'd' }],
    )
    expect(summary.rows.map((row) => row.title)).toEqual(['来店スタンプを設定する', 'オンライン決済を設定する', '入ったお知らせを動かす', 'お店の写真とロゴを入れる'])
    expect(summary.rows.find(row => row.key === 'payment')?.badge.label).toBe('未設定')
    expect(summary.rows.find(row => row.key === 'images')?.badge.label).toBe('見本')
    expect(summary.rows[0].action.href).toBe('/visit-stamps')
    expect(summary.rows[1].action.href).toBe('/booking/menus?tab=payments')
    expect(summary.done).toBe(3)
    expect(summary.total).toBe(11)
  })

  it('未定（あとで）の質問は入れない：答えが無い物は済みに数えず、行も出さない', () => {
    const summary = summarizeSetup({ ...state, answers: {} }, [], [])
    expect(summary.done).toBe(1)
    expect(summary.rows).toEqual([])
  })

  it('ECでは来店スタンプの質問と注意をどちらも出さない', () => {
    const ec = summarizeSetup(
      { ...state, style: 'ec' },
      [{ feature: 'stamps', areaId: 'E', groupId: 'g', href: '/visit-stamps', customerState: 'preparing' }],
      [],
    )
    expect(ec.rows.some((row) => row.key === 'stamps')).toBe(false)
    expect(ec.rows.some((row) => row.title.includes('スタンプ'))).toBe(false)
  })
})

describe('開き直したときの保存', () => {
  it('変えた答えだけを送り、予約設定が変わる答えは確かめの文を作る', async () => {
    const { changedAnswers, settingsChanges, isBookingConfirmSample } = await import('./model')
    const saved = { approval: { mode: 'configured' as const, value: 'automatic' }, reminders: { mode: 'configured' as const, value: true } }
    const next = { approval: { mode: 'configured' as const, value: 'automatic' }, reminders: { mode: 'configured' as const, value: false } }
    expect(changedAnswers(saved, next)).toEqual({ reminders: { mode: 'configured', value: false } })
    expect(settingsChanges(saved, next)).toEqual([])
    expect(settingsChanges(saved, { ...next, approval: { mode: 'configured', value: 'manual' } })).toEqual(['予約の確定の仕方：その場で確定する → お店が承認してから確定する'])
    expect(isBookingConfirmSample({ key: 'reminder', kind: 'automation', name: '予約確定のご案内' })).toBe(true)
    expect(isBookingConfirmSample({ key: 'reminder-day-before', kind: 'automation', name: '前日のお知らせ' })).toBe(false)
  })
})
