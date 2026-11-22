import type { FormBlock, FormInputBlock, FormLayout } from '@line-crm/shared'
import type { BookingRouting, RoutingTarget } from '@line-crm/shared'
import { isChoiceType } from './model'

/*
 * 答えで予約の行き先を分ける（B6-1・BGoRL）の決まり。
 * 条件に使えるのは 1 つ選ぶ・いくつでも選ぶ・プルダウンの質問（自由記述は当て方がぶれるので使えない）。
 * 上から順に最初に当たった行。最後の「どれにも当たらないとき」は消せず、メニューを選ぶまで保存できない。行は 50 まで。
 */
export type FormRouting = BookingRouting
export type RoutingRule = BookingRouting['rules'][number]
export { type RoutingTarget }
export const MAX_ROUTING_ROWS = 50
export const emptyTarget = (): RoutingTarget => ({ menuId: '' })
export const emptyRouting = (): FormRouting => ({ enabled: false, rules: [], fallback: emptyTarget() })

/** 条件に使える質問（予約ブロックより前・同じフォームの選ぶ質問）。 */
export function routingQuestions(blocks: FormBlock[]): FormInputBlock[] {
  return blocks.filter((b): b is FormInputBlock => b.kind === 'input' && (b.type === 'rating' || (isChoiceType(b.type) && (b.choices?.length ?? 0) > 0)))
}
export const hasBookingBlock = (blocks: FormBlock[]) => blocks.some((b) => b.kind === 'input' && b.type === 'booking')
export const choiceModeLabel = (type: string) => (type === 'radio' ? '1 つ選ぶ' : type === 'checkbox' ? 'いくつでも選ぶ' : type === 'rating' ? '5段階評価' : 'プルダウン')

export function newRule(questionId: string, answer: string, type?: string): RoutingRule {
  return { conditions: [type === 'rating' ? { questionId, op: 'between', value: [1, 5] } : { questionId, op: 'is', value: answer }], target: emptyTarget() }
}
const answerOf = (rule: RoutingRule) => String(rule.conditions[0]?.value ?? '')
export const ruleAnswer = answerOf

/** 上から順に最初に当たった行の番号。当たらなければ -1（＝どれにも当たらない）。 */
export function matchRule(routing: FormRouting, questionId: string, answers: string[]): number {
  return routing.rules.findIndex((rule) => rule.conditions.every((c) => c.questionId === questionId && answers.includes(String(c.value))))
}

/** 保存の前の確かめ。誤りの行（0 始まり・fallback は rules.length）と文を返す。 */
export function routingError(routing: FormRouting | undefined): { row: number; message: string } | null {
  if (!routing?.enabled) return null
  if (routing.rules.length > MAX_ROUTING_ROWS) return { row: MAX_ROUTING_ROWS, message: `行き先は ${MAX_ROUTING_ROWS} 行までです。` }
  const invalidRange = routing.rules.findIndex((rule) => rule.conditions.some((condition) => condition.op === 'between' && (!Array.isArray(condition.value) || condition.value.length !== 2 || Number(condition.value[0]) > Number(condition.value[1]))))
  if (invalidRange >= 0) return { row: invalidRange, message: `${invalidRange + 1} 行目の範囲を確認してください。` }
  const bad = routing.rules.findIndex((rule) => !rule.target.menuId)
  if (bad >= 0) return { row: bad, message: `${bad + 1} 行目の出すメニューを選んでください。` }
  if (!routing.fallback.menuId) return { row: routing.rules.length, message: '「どれにも当たらないとき」の出すメニューを選んでください。' }
  return null
}

/** 予約ブロック（最初の 1 つ）の booking.routing が決まり。保存は回答フォームの版（layout）に含まれる。 */
const bookingBlocks = (layout: FormLayout): FormInputBlock[] => [...layout.header, ...layout.sections.flatMap((s) => s.blocks)].filter((b): b is FormInputBlock => b.kind === 'input' && b.type === 'booking')
export const routingOf = (layout: FormLayout): FormRouting | undefined => bookingBlocks(layout)[0]?.booking?.routing
export function withRouting(layout: FormLayout, routing: FormRouting): FormLayout {
  const target = bookingBlocks(layout)[0]
  if (!target) return layout
  const patch = (b: FormBlock): FormBlock => (b === target ? { ...target, booking: { menuId: '', staffId: null, daysAhead: 14, ...target.booking, routing } } : b)
  return { ...layout, header: layout.header.map(patch), sections: layout.sections.map((sec) => ({ ...sec, blocks: sec.blocks.map(patch) })) }
}
