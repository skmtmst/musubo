import { expect, test } from 'vitest'
import type { FormBlock, FormInputBlock } from '@line-crm/shared'
import { type FormRouting, type RoutingRule, conflictingQuestion, emptyRouting, hasBookingBlock, matchRule, newRule, nextCondition, routingError, routingQuestions } from './routing-model'

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

test('答えが1つの質問に同時に満たせない条件が重なった行を見つける。いくつでも選ぶ質問と重なりのある範囲は止めない', () => {
  const select = { ...radio, id: 'q5', type: 'select' } as unknown as FormBlock
  const checkbox = { ...radio, id: 'q6', type: 'checkbox' } as unknown as FormBlock
  const rating = { id: 'q4', kind: 'input', type: 'rating', name: 'score', label: '満足度' } as unknown as FormBlock
  const blocks = [radio, select, checkbox, rating]
  const row = (conditions: RoutingRule['conditions']): RoutingRule => ({ conditions, target: { menuId: 'bm-1' } })
  expect(conflictingQuestion(row([{ questionId: 'q1', op: 'is', value: 'トリミング' }, { questionId: 'q1', op: 'is', value: 'しつけ' }]), blocks)?.id).toBe('q1')
  expect(conflictingQuestion(row([{ questionId: 'q5', op: 'is', value: 'トリミング' }, { questionId: 'q5', op: 'in', value: ['しつけ'] }]), blocks)?.id).toBe('q5')
  expect(conflictingQuestion(row([{ questionId: 'q4', op: 'between', value: [1, 2] }, { questionId: 'q4', op: 'between', value: [4, 5] }]), blocks)?.id).toBe('q4')
  // 両方を満たす答えがあるなら当たる（対照）。
  expect(conflictingQuestion(row([{ questionId: 'q1', op: 'in', value: ['トリミング', 'しつけ'] }, { questionId: 'q1', op: 'is', value: 'しつけ' }]), blocks)).toBeNull()
  expect(conflictingQuestion(row([{ questionId: 'q6', op: 'is', value: 'トリミング' }, { questionId: 'q6', op: 'is', value: 'しつけ' }]), blocks)).toBeNull()
  expect(conflictingQuestion(row([{ questionId: 'q4', op: 'between', value: [1, 4] }, { questionId: 'q4', op: 'between', value: [3, 5] }]), blocks)).toBeNull()
  expect(conflictingQuestion(row([{ questionId: 'q1', op: 'is', value: 'トリミング' }, { questionId: 'q6', op: 'is', value: 'しつけ' }]), blocks)).toBeNull()
})

test('保存の前の確かめは、質問を渡すと同時に満たせない行を止める。いくつでも選ぶから1つ選ぶへ変えた質問も止める', () => {
  const checkbox = { ...radio, type: 'checkbox' } as unknown as FormBlock
  const rule: RoutingRule = { conditions: [{ questionId: 'q1', op: 'is', value: 'トリミング' }, { questionId: 'q1', op: 'is', value: 'しつけ' }], target: { menuId: 'bm-1' } }
  const routing: FormRouting = { enabled: true, rules: [{ ...newRule('q1', 'しつけ'), target: { menuId: 'bm-1' } }, rule], fallback: { menuId: 'bm-1' } }
  expect(routingError(routing, [checkbox, booking])).toBeNull()
  expect(routingError(routing, [radio, booking])).toEqual({ row: 1, message: '2 行目の「ご相談の内容」の条件は同時に満たせません。どちらかを外すか、行を分けてください。' })
  expect(routingError({ ...routing, enabled: false }, [radio, booking])).toBeNull()
})

test('条件を足すとき、答えが1つの質問は1行に1つまで。いくつでも選ぶ質問はまだ使っていない答えを足し、3つまで', () => {
  const question = (block: FormBlock) => block as FormInputBlock
  const checkbox = question({ ...radio, type: 'checkbox' } as unknown as FormBlock)
  const rating = question({ id: 'q4', kind: 'input', type: 'rating', name: 'score', label: '満足度' } as unknown as FormBlock)
  const row = (conditions: RoutingRule['conditions']): RoutingRule => ({ conditions, target: { menuId: '' } })
  expect(nextCondition(row([{ questionId: 'q1', op: 'is', value: 'しつけ' }]), question(radio))).toBeNull()
  expect(nextCondition(row([{ questionId: 'q4', op: 'between', value: [1, 5] }]), rating)).toBeNull()
  expect(nextCondition(row([{ questionId: 'q4', op: 'between', value: [1, 5] }]), question(radio))).toEqual({ questionId: 'q1', op: 'is', value: 'トリミング' })
  expect(nextCondition(row([{ questionId: 'q1', op: 'is', value: 'しつけ' }]), rating)).toEqual({ questionId: 'q4', op: 'between', value: [1, 5] })
  expect(nextCondition(row([{ questionId: 'q1', op: 'is', value: 'トリミング' }]), checkbox)).toEqual({ questionId: 'q1', op: 'is', value: 'しつけ' })
  expect(nextCondition(row([{ questionId: 'q1', op: 'in', value: ['トリミング', 'しつけ'] }]), checkbox)).toBeNull()
  expect(nextCondition(row([{ questionId: 'q4', op: 'between', value: [1, 5] }, { questionId: 'q9', op: 'is', value: 'a' }, { questionId: 'q8', op: 'is', value: 'b' }]), checkbox)).toBeNull()
})
