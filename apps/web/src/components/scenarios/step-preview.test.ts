/*
 * 1通目のプレビューが出す「届く日時」。
 *
 * ここがずれると、画面に出ている日時と実際の配信が食い違う。設定を疑って
 * 探し回ることになるので、worker の computeNextDeliveryAt と同じ扱いに
 * そろえてある。特に「時刻で指定」で、その日の配信時刻をもう過ぎている
 * ときの繰り上がりを見る。
 */
import { describe, it, expect } from 'vitest'
import { emptySchedule } from './schedule-input'
import { computeDeliveryAt, previewOffsets, renderPreviewBody, isDeliveryTimeSet } from './step-preview'

/** JSTの日時をローカルのDateとして組み立てる（画面側と同じ扱い）。 */
function at(y: number, m: number, d: number, hh: number, mm = 0): Date {
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

describe('時刻で指定', () => {
  it('追加する通も1通目と同じ10時を初期値にする', () => { expect(emptySchedule.deliveryTime).toBe('10:00') })
  it('0日後で、まだ配信時刻を過ぎていなければ当日', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 8, 30), 'absolute_time', 0, '10:00', 0)
    expect(out.getDate()).toBe(19)
    expect(out.getHours()).toBe(10)
  })

  it('0日後で、配信時刻をもう過ぎていればすぐ', () => {
    // 11:00 に購読開始 → その日の 10:00 は過ぎている
    const out = computeDeliveryAt(at(2026, 8, 19, 11, 0), 'absolute_time', 0, '10:00', 0)
    expect(out.getDate()).toBe(19)
    expect(out.getHours()).toBe(11)
  })

  it('1日後は、購読開始の翌日の決めた時刻', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 23, 50), 'absolute_time', 1, '10:00', 0)
    expect(out.getMonth() + 1).toBe(8)
    expect(out.getDate()).toBe(20)
    expect(out.getHours()).toBe(10)
    expect(out.getMinutes()).toBe(0)
  })

  it('月をまたいでも正しい日になる', () => {
    const out = computeDeliveryAt(at(2026, 8, 31, 9, 0), 'absolute_time', 1, '10:00', 0)
    expect(out.getMonth() + 1).toBe(9)
    expect(out.getDate()).toBe(1)
  })
})

describe('経過時間で指定', () => {
  it('購読開始からの経過で決まる（時刻はそろわない）', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 14, 30), 'elapsed', 1, '10:00', 3)
    expect(out.getDate()).toBe(20)
    expect(out.getHours()).toBe(17)
    expect(out.getMinutes()).toBe(30)
  })

  it('0日0時間なら、購読開始と同じ時刻', () => {
    const start = at(2026, 8, 19, 14, 30)
    const out = computeDeliveryAt(start, 'elapsed', 0, '10:00', 0)
    expect(out.getTime()).toBe(start.getTime())
  })

  it('時間が日をまたいでも繰り上がる', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 22, 0), 'elapsed', 0, '10:00', 5)
    expect(out.getDate()).toBe(20)
    expect(out.getHours()).toBe(3)
  })
})

/*
 * #616 SC-02b: 編集フォームの入力値をプレビューの「日・時間・分」へ
 * 写す変換。分が抜けると、設定内容は「1分後」なのに配信の流れ・
 * 設定サマリーが「すぐに」のまま残る。
 */
describe('プレビューへ渡す日・時間・分（previewOffsets）', () => {
  it('elapsed は 日・時間・分をそのまま渡す（1分が0に化けない）', () => {
    const out = previewOffsets('elapsed', {
      delayMinutes: 0,
      offsetDays: 0,
      offsetHours: 0,
      offsetMinutesRemainder: 1,
    })
    expect(out).toEqual({ offsetDays: 0, offsetHours: 0, offsetMinutes: 1 })
  })

  it('relative は delayMinutes の合計を日・時間・分へ分解する', () => {
    expect(
      previewOffsets('relative', {
        delayMinutes: 1,
        offsetDays: 0,
        offsetHours: 0,
        offsetMinutesRemainder: 0,
      }),
    ).toEqual({ offsetDays: 0, offsetHours: 0, offsetMinutes: 1 })
    expect(
      previewOffsets('relative', {
        delayMinutes: 1500,
        offsetDays: 0,
        offsetHours: 0,
        offsetMinutesRemainder: 0,
      }),
    ).toEqual({ offsetDays: 1, offsetHours: 1, offsetMinutes: 0 })
  })

  it('absolute_time は日だけ使い、時間・分は配信時刻側に任せる', () => {
    const out = previewOffsets('absolute_time', {
      delayMinutes: 90,
      offsetDays: 2,
      offsetHours: 3,
      offsetMinutesRemainder: 30,
    })
    expect(out).toEqual({ offsetDays: 2, offsetHours: 0, offsetMinutes: 0 })
  })
})

/*
 * R235: 時刻を消したまま（''）でも、NaN の日時を作らない。
 * 以前は分の取り出しが undefined になり、setHours が Invalid Date を作って
 * 「NaN月NaN日(undefined) NaN:NaN」と出ていた。呼び側は未設定表示にする。
 */
describe('時刻が空のまま（R235）', () => {
  it('時刻の有無を見分ける（00:00 と 23:59 は有効）', () => {
    expect(isDeliveryTimeSet('')).toBe(false)
    expect(isDeliveryTimeSet('9:00')).toBe(false)
    expect(isDeliveryTimeSet('24:00')).toBe(false)
    expect(isDeliveryTimeSet('00:00')).toBe(true)
    expect(isDeliveryTimeSet('23:59')).toBe(true)
  })

  it('空の時刻でも壊れた日時を作らない（NaNを出さない）', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 8, 30), 'absolute_time', 0, '', 0)
    expect(Number.isNaN(out.getTime())).toBe(false)
    expect(Number.isNaN(out.getMonth())).toBe(false)
    expect(Number.isNaN(out.getDate())).toBe(false)
  })

  it('崩れた時刻でも壊れた日時を作らない', () => {
    const out = computeDeliveryAt(at(2026, 8, 19, 8, 30), 'absolute_time', 0, 'あ', 0)
    expect(Number.isNaN(out.getTime())).toBe(false)
  })
})

describe('メッセージ本文のプレビュー', () => {
  it('名前と日付を安全な例へ置き換える', () => {
    expect(renderPreviewBody('{{name}}さん、{{date}}にお届けします')).toBe(
      '見本 143さん、10月2日にお届けします',
    )
    expect(renderPreviewBody('{{お名前}}さん')).toBe('見本 143さん')
  })
})
