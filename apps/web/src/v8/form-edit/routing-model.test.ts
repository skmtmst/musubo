import { expect, test } from 'vitest'
import type { FormBlock } from '@line-crm/shared'
import { type FormRouting, emptyRouting, hasBookingBlock, matchRule, newRule, routingError, routingQuestions } from './routing-model'

const radio = { id: 'q1', kind: 'input', type: 'radio', name: 'k', label: 'ご相談の内容', choices: [{ id: 'a', label: 'トリミング' }, { id: 'b', label: 'しつけ' }] } as unknown as FormBlock
const text = { id: 'q2', kind: 'input', type: 'textarea', name: 't', label: '自由記述' } as unknown as FormBlock
const booking = { id: 'q3', kind: 'input', type: 'booking', name: 'b', label: '予約' } as unknown as FormBlock

test('条件に使えるのは選ぶ質問だけ。自由記述は当て方がぶれるので出さない', () => {
  expect(routingQuestions([radio, text, booking]).map((q) => q.id)).toEqual(['q1'])
  expect(hasBookingBlock([radio, text])).toBe(false)
  expect(hasBookingBlock([radio, booking])).toBe(true)
})

test('上から順に最初に当たった行。当たらなければ -1（どれにも当たらないとき）', () => {
  const r1 = newRule('q1', 'しつけ'); const r2 = newRule('q1', 'トリミング')
  const routing: FormRouting = { ...emptyRouting(), enabled: true, rules: [r1, r2] }
  expect(matchRule(routing, 'q1', ['トリミング'])).toBe(1)
  expect(matchRule(routing, 'q1', ['しつけ', 'トリミング'])).toBe(0)
  expect(matchRule(routing, 'q1', ['料金'])).toBe(-1)
})

test('保存の前の確かめ：行き先のメニューと「どれにも当たらないとき」の行き先は必須。オフなら確かめない', () => {
  const rule = newRule('q1', 'トリミング')
  expect(routingError(undefined)).toBeNull()
  expect(routingError({ ...emptyRouting(), enabled: false })).toBeNull()
  expect(routingError({ ...emptyRouting(), enabled: true, rules: [rule] })?.message).toContain('1 行目')
  const ok = { ...rule, target: { menuId: 'bm-1' } }
  expect(routingError({ enabled: true, rules: [ok], fallback: { menuId: '' } })?.message).toContain('どれにも当たらないとき')
  expect(routingError({ enabled: true, rules: [ok], fallback: { menuId: 'bm-5' } })).toBeNull()
})

test('行は 50 まで', () => {
  const rules = Array.from({ length: 51 }, () => ({ ...newRule('q1', 'a'), target: { menuId: 'bm-1' } }))
  expect(routingError({ enabled: true, rules, fallback: { menuId: 'bm-1' } })?.message).toContain('50')
})

test('5段階評価は範囲条件を使い、逆の範囲は保存できない', () => {
  const rating = { id:'q4',kind:'input',type:'rating',name:'score',label:'満足度' } as unknown as FormBlock
  expect(routingQuestions([rating]).map((q) => q.id)).toEqual(['q4'])
  const rule = {...newRule('q4','', 'rating'),target:{menuId:'bm-1'}}
  expect(rule.conditions[0]).toEqual({questionId:'q4',op:'between',value:[1,5]})
  expect(routingError({enabled:true,rules:[{...rule,conditions:[{questionId:'q4',op:'between',value:[5,1]}]}],fallback:{menuId:'bm-1'}})?.message).toContain('範囲')
})
