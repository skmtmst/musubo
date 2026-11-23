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
/**
 * このフォームを使う店。行き先のメニューは店ごとに違い、保存はフォームを使う全部の店で行き先を確かめる。
 * single＝この店だけ／shared＝ほかの店でも使う／checking＝確かめている／unknown＝確かめられなかった。
 */
export type RoutingStoreScope = 'single' | 'shared' | 'checking' | 'unknown'
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

type RoutingCondition = RoutingRule['conditions'][number]
const MAX_ROUTING_CONDITIONS = 3
/** 条件が受け付ける答え。比べられない形は null（ほかの検査に任せる）。 */
const acceptedAnswers = (condition: RoutingCondition): string[] | null =>
  condition.op === 'is' ? [String(condition.value)] : condition.op === 'in' && Array.isArray(condition.value) ? condition.value.map(String) : null

/**
 * 1 行の条件は「すべて満たす」。答えが 1 つの質問（1 つ選ぶ・プルダウン・5段階評価）に、
 * 同時には満たせない条件が重なった行は当たらない。その質問を返す（無ければ null）。
 */
export function conflictingQuestion(rule: RoutingRule, blocks: FormBlock[]): FormInputBlock | null {
  for (const questionId of new Set(rule.conditions.map((condition) => condition.questionId))) {
    const question = blocks.find((block): block is FormInputBlock => block.kind === 'input' && block.id === questionId)
    const conditions = rule.conditions.filter((condition) => condition.questionId === questionId)
    if (!question || question.type === 'checkbox' || conditions.length < 2) continue
    if (question.type === 'rating') {
      const ranges = conditions.flatMap((condition) => (condition.op === 'between' && Array.isArray(condition.value) ? [condition.value.map(Number)] : []))
      if (ranges.length === conditions.length && Math.max(...ranges.map((range) => range[0])) > Math.min(...ranges.map((range) => range[1]))) return question
      continue
    }
    const accepted = conditions.map(acceptedAnswers)
    if (!accepted.every((answers): answers is string[] => answers !== null)) continue
    const common = accepted[0].filter((answer) => accepted.every((answers) => answers.includes(answer)))
    if (common.length === 0) return question
  }
  return null
}

/**
 * 「選んだ質問の条件を追加」で足す条件。足せないときは null。
 * いくつでも選ぶ質問は、その行でまだ使っていない答えを足す。答えが 1 つの質問は 1 行に 1 つまで（2 つ目は同時に満たせないか、意味が重なるだけ）。
 */
export function nextCondition(rule: RoutingRule, question: FormInputBlock): RoutingCondition | null {
  if (rule.conditions.length >= MAX_ROUTING_CONDITIONS) return null
  const same = rule.conditions.filter((condition) => condition.questionId === question.id)
  if (question.type === 'checkbox') {
    const used = new Set(same.flatMap((condition) => acceptedAnswers(condition) ?? []))
    const choice = (question.choices ?? []).find((item) => !used.has(item.label))
    return choice ? { questionId: question.id, op: 'is', value: choice.label } : null
  }
  if (same.length > 0) return null
  return newRule(question.id, question.choices?.[0]?.label ?? '', question.type).conditions[0]
}

/** 上から順に最初に当たった行の番号。当たらなければ -1（＝どれにも当たらない）。 */
export function matchRule(routing: FormRouting, questionId: string, answers: string[]): number {
  return routing.rules.findIndex((rule) => rule.conditions.every((c) => c.questionId === questionId && answers.includes(String(c.value))))
}

/**
 * 保存の前の確かめ。誤りの行（0 始まり・fallback は rules.length）と文を返す。
 * blocks を渡すと、答えが 1 つの質問に同時には満たせない条件が重なった行も止める。
 */
export function routingError(routing: FormRouting | undefined, blocks?: FormBlock[]): { row: number; message: string } | null {
  if (!routing?.enabled) return null
  if (routing.rules.length > MAX_ROUTING_ROWS) return { row: MAX_ROUTING_ROWS, message: `行き先は ${MAX_ROUTING_ROWS} 行までです。` }
  const invalidRange = routing.rules.findIndex((rule) => rule.conditions.some((condition) => condition.op === 'between' && (!Array.isArray(condition.value) || condition.value.length !== 2 || Number(condition.value[0]) > Number(condition.value[1]))))
  if (invalidRange >= 0) return { row: invalidRange, message: `${invalidRange + 1} 行目の範囲を確認してください。` }
  if (blocks) {
    for (const [row, rule] of routing.rules.entries()) {
      const question = conflictingQuestion(rule, blocks)
      if (question) return { row, message: `${row + 1} 行目の「${question.label}」の条件は同時に満たせません。どちらかを外すか、行を分けてください。` }
    }
  }
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
