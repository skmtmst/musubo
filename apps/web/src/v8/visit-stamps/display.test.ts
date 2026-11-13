import { describe, expect, it } from 'vitest'
import type { VisitStampEntry } from '@line-crm/shared'
import { defaultSettings, friendLabel, historyRows, manualReasonText, multiplierDetail, multiplierName, previewSlots, rewardNote, settingsProblem, shortDateTime, slotCount, withSlotCount, stackedCap } from './display'

const settings = { ...defaultSettings(), rewards: [{ id: 'a', name: 'ドリンク 1杯', stamps: 5 }, { id: 'b', name: 'デザート 1品', stamps: 10 }] }
const entry = (id: string, kind: string, delta: number, actorId: string | null, reason: string, createdAt: string, originalId: string | null = null): VisitStampEntry =>
  ({ id, cardId: 'c', friendId: 'f', accountId: 'acc', kind, delta, actorId, reason, createdAt, originalId })

describe('来店スタンプの見せ方', () => {
  it('マスの数は特典の個数と別（API-10 の slotCount）。無い古いカードはいちばん大きい特典。マスより大きい特典は詰める', () => {
    expect(slotCount(settings)).toBe(10)
    expect(slotCount({ ...settings, slotCount: 12 })).toBe(12)
    const next = withSlotCount(settings, 4)
    expect(next.slotCount).toBe(4)
    expect(next.rewards.map((r) => r.stamps)).toEqual([4, 4])
    const wider = withSlotCount(settings, 12)
    expect(wider.slotCount).toBe(12)
    expect(wider.rewards.map((r) => r.stamps)).toEqual([5, 10])
    expect(settingsProblem('カード', { ...settings, slotCount: 8 })).toBe('特典の個数をマスの数以下にしてください。')
    expect(stackedCap(settings)).toBe(settings.maxPerVisit)
    expect(stackedCap({ ...settings, maxStackedStamps: 8 })).toBe(8)
  })

  it('特典の下の1行は、サーバの減らし方どおり（途中の特典は減る数・最後は新しいカード）', () => {
    expect(rewardNote(settings.rewards[0], settings)).toBe('使うとスタンプが 5 個へる')
    expect(rewardNote(settings.rewards[1], settings)).toBe('使ったら新しいカードへ')
  })

  it('お客さまの見え方：済み・特典・空きのマス', () => {
    const slots = previewSlots(settings, 3)
    expect(slots).toHaveLength(10)
    expect(slots.slice(0, 5).map((s) => s.state)).toEqual(['done', 'done', 'done', 'empty', 'reward'])
    expect(slots[9].state).toBe('reward')
  })

  it('倍率の名前と中身（期間の終わりはその日を含めて見せる）', () => {
    const m = { multiplier: 2, weekdays: [2], startMinute: 1020, endMinute: 1140, from: '2025-12-31T15:00:00.000Z', to: '2026-03-31T15:00:00.000Z' }
    expect(multiplierName(m)).toBe('2倍デー')
    expect(multiplierDetail(m)).toBe('毎週 火曜 17:00〜19:00・01/01〜03/31')
    expect(multiplierName({ multiplier: 1.5, from: '2026-01-01T00:00:00Z' })).toBe('1.5倍の期間')
    expect(multiplierDetail({ multiplier: 3 })).toBe('いつでも')
  })

  it('記録：取り消しは元の行にまとめ、理由と誰が は取り消しのもの。新しい順', () => {
    const names = (id: string) => ({ s1: '田村', s2: 'Kenta' } as Record<string, string>)[id]
    const rows = historyRows([
      entry('e1', 'manual', 1, 's1', '押し忘れ', '2026-01-11T10:02:00Z'),
      entry('e2', 'reverse', -1, 's2', 'まちがい', '2026-01-11T10:30:00Z', 'e1'),
      entry('e3', 'redeem', -10, 's1', 'デザート 1品', '2026-01-13T09:10:00Z'),
      entry('e4', 'visit', 1, null, '', '2026-01-12T03:05:00Z'),
      entry('e5', 'paper', 7, 's2', '写真を確認', '2026-01-12T11:30:00Z'),
    ], names)
    expect(rows.map((r) => r.id)).toEqual(['e3', 'e5', 'e4', 'e1'])
    expect(rows[0]).toMatchObject({ count: '−10 個（特典）', why: 'デザート 1品を使った', actor: '店員：田村（暗証番号）', reversible: true })
    expect(rows[1]).toMatchObject({ count: '+7 個', why: '紙のカードから移行', actor: 'Kenta（承認）' })
    expect(rows[2]).toMatchObject({ count: '+1 個', why: '来店', actor: '自動' })
    expect(rows[3]).toMatchObject({ count: '+1 個 → 取り消し', why: 'まちがい', actor: 'Kenta', reversed: true, reversible: false })
  })

  it('日時は日本時間（D1 の「YYYY-MM-DD HH:MM:SS」も UTC として読む）', () => {
    expect(shortDateTime('2026-01-13T09:40:00.000Z')).toBe('01/13 18:40')
    expect(shortDateTime('2026-01-12 11:14:00')).toBe('01/12 20:14')
  })

  it('手入力の理由とメモ・友だちの名前', () => {
    expect(manualReasonText('paper', ' レシートを確認済み ')).toBe('紙のカードから移す：レシートを確認済み')
    expect(manualReasonText('forgot', '')).toBe('押し忘れ')
    expect(friendLabel({ displayName: 'けんじ', metadata: { name: '見本 115' } })).toBe('見本 115（LINE：けんじ）')
    expect(friendLabel({ displayName: 'けんじ' })).toBe('けんじ')
  })

  it('保存の前の検査（サーバと同じ境目）', () => {
    expect(settingsProblem('', settings)).toMatch('カードの名前')
    expect(settingsProblem('カード', { ...settings, rewards: [] })).toMatch('特典を1つ以上')
    expect(settingsProblem('カード', { ...settings, mode: 'amount', amountUnit: 0 })).toMatch('何円ごと')
    expect(settingsProblem('カード', { ...settings, maxPerVisit: 0 })).toMatch('上限')
    expect(settingsProblem('カード', settings)).toBeNull()
  })

  it('倍率に付けた名前があればそれを出す。止めたランクは「止めています」', () => {
    expect(multiplierName({ name: '火曜の2倍デー', multiplier: 2, weekdays: [2] })).toBe('火曜の2倍デー')
    expect(multiplierName({ multiplier: 2, weekdays: [2] })).toBe('2倍デー')
  })
})
