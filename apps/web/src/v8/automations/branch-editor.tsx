'use client'

import { automationWaitLabel } from '@line-crm/shared'
import { knownValue } from '@/lib/known-value'

import type { CommonActionResources, CommonActionStep } from '@/lib/api'
import { newCommonActionStep, newStepId } from '@/components/automations/common-action-editor'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { ACTION_LABELS } from './version-diff'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import BranchActionList from '@/components/automations/branch-action-list'
import EntitySelect from '@/components/shared/entity-select'

/* 写し：app/common-actions/branch-editor.tsx（src/v8 は古い画面ファイルを import できない）。中身は変えていない。 */

export function newBranchStep(): CommonActionStep {
  return {
    id: newStepId(),
    type: 'branch',
    params: {
      condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: '' }] },
      then: [{ ...newCommonActionStep('common_action'), params: { commonActionId: '' } }],
      else: [{ ...newCommonActionStep('common_action'), params: { commonActionId: '' } }],
    },
    onFailure: 'stop',
  }
}

/*
 * 監査 R476: 分岐の編集で画面に出ない条件と後続の子処理を消さない。
 * AND/OR・全条件・両側の全処理を表示し、対象の項目だけを更新する。
 * 対象以外の配列は絶対に切り詰めない。表示できない構造は読み取り専用の
 * 行で残し、単純な選択欄で上書きさせない。削除は明示操作に限る。
 */
export type BranchPatch =
  | { kind: 'operator'; operator: 'AND' | 'OR' }
  | { kind: 'ruleTag'; ruleIndex: number; tagId: string }
  | { kind: 'ruleAdd' }
  | { kind: 'ruleRemove'; ruleIndex: number }
  | { kind: 'sideAction'; side: 'then' | 'else'; stepIndex: number; commonActionId: string }
  | { kind: 'sideSet'; side: 'then' | 'else'; steps: CommonActionStep[] }
  | { kind: 'sideAdd'; side: 'then' | 'else' }
  | { kind: 'sideRemove'; side: 'then' | 'else'; stepIndex: number }

type BranchCondition = {
  operator?: unknown
  rules?: Array<{ type?: unknown; value?: unknown }>
}

function branchCondition(step: CommonActionStep): { operator: 'AND' | 'OR'; rules: Array<{ type: string; value: string }> } {
  const condition = step.params.condition as BranchCondition | undefined
  const rules = Array.isArray(condition?.rules)
    ? condition.rules.map((rule) => ({
      type: typeof rule.type === 'string' ? rule.type : 'tag_exists',
      value: typeof rule.value === 'string' ? rule.value : '',
    }))
    : []
  return {
    operator: condition?.operator === 'OR' ? 'OR' : 'AND',
    rules,
  }
}

function branchSides(step: CommonActionStep): { thenSteps: CommonActionStep[]; elseSteps: CommonActionStep[] } {
  const thenSteps = Array.isArray(step.params.then) ? (step.params.then as CommonActionStep[]) : []
  const elseSteps = Array.isArray(step.params.else) ? (step.params.else as CommonActionStep[]) : []
  return { thenSteps, elseSteps }
}

function newReferenceStep(): CommonActionStep {
  return { ...newCommonActionStep('common_action'), params: { commonActionId: '' } }
}

export function updateBranchStep(step: CommonActionStep, patch: BranchPatch): CommonActionStep {
  if (step.type !== 'branch') return step
  const condition = branchCondition(step)
  const { thenSteps, elseSteps } = branchSides(step)
  switch (patch.kind) {
    case 'operator':
      return {
        ...step,
        params: { ...step.params, condition: { operator: patch.operator, rules: condition.rules } },
      }
    case 'ruleTag': {
      if (!condition.rules[patch.ruleIndex]) return step
      const rules = condition.rules.map((rule, index) =>
        // 種別は保ち、タグの値だけ変える。他の条件は触らない。
        index === patch.ruleIndex ? { ...rule, value: patch.tagId } : rule,
      )
      return {
        ...step,
        params: { ...step.params, condition: { operator: condition.operator, rules } },
      }
    }
    case 'ruleAdd':
      return {
        ...step,
        params: {
          ...step.params,
          condition: { operator: condition.operator, rules: [...condition.rules, { type: 'tag_exists', value: '' }] },
        },
      }
    case 'ruleRemove': {
      if (condition.rules.length <= 1 || !condition.rules[patch.ruleIndex]) return step
      const rules = condition.rules.filter((_, index) => index !== patch.ruleIndex)
      return {
        ...step,
        params: { ...step.params, condition: { operator: condition.operator, rules } },
      }
    }
    case 'sideAction': {
      const target = patch.side === 'then' ? thenSteps : elseSteps
      const current = target[patch.stepIndex]
      // 先頭だけ置き換えない。対象の行だけ変え、他の子処理は残す。
      if (!current || current.type !== 'common_action') return step
      const next = target.map((item, index) =>
        index === patch.stepIndex ? { ...item, params: { ...item.params, commonActionId: patch.commonActionId } } : item,
      )
      return { ...step, params: { ...step.params, [patch.side]: next } }
    }
    case 'sideSet': return { ...step, params: { ...step.params, [patch.side]: patch.steps } }
    case 'sideAdd': {
      const next = [...(patch.side === 'then' ? thenSteps : elseSteps), newReferenceStep()]
      return { ...step, params: { ...step.params, [patch.side]: next } }
    }
    case 'sideRemove': {
      const target = patch.side === 'then' ? thenSteps : elseSteps
      if (target.length <= 1 || !target[patch.stepIndex]) return step
      const next = target.filter((_, index) => index !== patch.stepIndex)
      return { ...step, params: { ...step.params, [patch.side]: next } }
    }
  }
}

const OPERATOR_LABEL: Record<'AND' | 'OR', string> = {
  AND: 'すべてに当てはまる',
  OR: 'どれかに当てはまる',
}

const RULE_TYPE_LABEL: Record<string, string> = Object.assign(Object.create(null), {
  tag_exists: 'タグがある',
  tag_not_exists: 'タグがない',
})

/* 編集画面で扱えない子処理は読み取り専用で残す。消さない。 */
function readonlyStepSummary(step: CommonActionStep): string {
  const label = knownValue(ACTION_LABELS, step.type, step.type)
  if (step.type === 'wait') {
    return automationWaitLabel(step.params)
  }
  return `「${label}」`
}

export default function BranchEditors({
  steps,
  resources,
  onUpdate,
  onRemove,
  onlyId,
}: {
  /* 全体の実行順の配列。分岐の見出し番号はここでの位置と一致させる（監査 R474）。 */
  steps: CommonActionStep[]
  resources: CommonActionResources
  onUpdate: (id: string, patch: BranchPatch) => void
  onRemove: (id: string) => void
  onlyId?: string
}) {
  const tagOptions = (selected: string) => [
    ...resources.tags,
    // 保存済みのタグが選択肢に無いときも値を保つ（消さない）。
    ...(selected && !resources.tags.some((tag) => tag.id === selected)
      ? [{ id: selected, name: '選択中のタグ（未取得。タグの一覧を読み込み直すと表示します）' }]
      : []),
  ]
  return (
    <>
      {steps.map((step, stepIndex) => {
        if (step.type !== 'branch' || (onlyId && step.id !== onlyId)) return null
        const branchNumber = stepIndex + 1
        const condition = branchCondition(step)
        const { thenSteps, elseSteps } = branchSides(step)
        const renderSide = (side: 'then' | 'else', sideSteps: CommonActionStep[], sideLabel: string) => (
          <div>
            <SaveErrorField names={["commonActionId","sideStep.params.commonActionId","params.commonActionId","common_action_id","side_step.params.common_action_id","params.common_action_id"]}><p className="text-ink-secondary mb-1 text-sm font-semibold">{sideLabel}</p></SaveErrorField>
            <BranchActionList
                    value={sideSteps} resources={resources} label={sideLabel} titleOf={readonlyStepSummary}
                    onChange={next => onUpdate(step.id, { kind: 'sideSet', side, steps: next })}
                  />
          </div>
        )
        return (
          <section key={step.id} className="border-hairline bg-canvas-sunken mt-3 rounded-card border p-4" data-common-action-branch>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-ink font-semibold">{branchNumber}. 条件で分ける</h3>
              <Button onClick={() => onRemove(step.id)}>分岐を削除する</Button>
            </div>
            <div className="mt-3">
              <span className="text-ink-secondary text-sm">条件の組み合わせ</span>
              <SaveErrorField names={["operator","condition.operator"]}><Select
                size="full"
                aria-label="条件の組み合わせ"
                className="mt-1"
                value={condition.operator}
                onChange={(value) => onUpdate(step.id, { kind: 'operator', operator: value as 'AND' | 'OR' })}
                options={[
                  { value: 'AND', label: OPERATOR_LABEL.AND },
                  { value: 'OR', label: OPERATOR_LABEL.OR },
                ]}
              /></SaveErrorField>
            </div>
            <div className="mt-3 space-y-2">
              {condition.rules.map((rule, ruleIndex) => rule.type === 'tag_exists' || rule.type === 'tag_not_exists' ? (
                <div key={`${step.id}-rule-${ruleIndex}`} className="flex items-center gap-2">
                  <div className="text-ink-secondary min-w-0 flex-1 text-sm">
                    <span>条件{ruleIndex + 1}（{RULE_TYPE_LABEL[rule.type]}）</span>
                    <div className="mt-1">
                      <SaveErrorField names={["value","rule.value"]}><EntityKindField
                        kind="tag"
                        label={`条件${ruleIndex + 1}のタグ`}
                        value={rule.value}
                        onChange={(value) => onUpdate(step.id, { kind: 'ruleTag', ruleIndex, tagId: value })}
                        options={tagOptions(rule.value)}
                      /></SaveErrorField>
                    </div>
                  </div>
                  {condition.rules.length > 1 ? (
                    <Button aria-label={`条件${ruleIndex + 1}を外す`} onClick={() => onUpdate(step.id, { kind: 'ruleRemove', ruleIndex })}>外す</Button>
                  ) : null}
                </div>
              ) : (
                <p key={`${step.id}-rule-${ruleIndex}`} className="text-ink-secondary text-sm">
                  条件{ruleIndex + 1}（{knownValue(RULE_TYPE_LABEL, rule.type, rule.type)}。ここでは変えられません）
                </p>
              ))}
              <Button onClick={() => onUpdate(step.id, { kind: 'ruleAdd' })}>条件を足す</Button>
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {renderSide('then', thenSteps, '当てはまるとき')}
              {renderSide('else', elseSteps, '当てはまらないとき')}
            </div>
            <p className="text-ink-faint mt-2 text-xs">タグ条件を判定し、選んだ公開版の共通アクションだけを実行します。選ばなかった側は実行記録へ「分岐対象外」と残ります。</p>
          </section>
        )
      })}
    </>
  )
}
