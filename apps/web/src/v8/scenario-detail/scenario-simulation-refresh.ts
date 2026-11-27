import type { Scenario, ScenarioStep } from '@line-crm/shared'
import type { ScenarioSimulation } from '@/lib/api'

type ScenarioWithSteps = Scenario & { steps: ScenarioStep[] }

/** 試算が結果と一緒に持つ「どの設定で計算したか」の記録。 */
export interface ScenarioSimulationResult {
  key: string
  value: ScenarioSimulation | null
}

/**
 * SCENARIO-15: 開始前の試算は「いま保存されている設定」に対する結果。
 *
 * 詳細画面の試算取得は以前、シナリオIDとアカウントだけを見ていた。
 * 対象条件・通・配信時刻を保存して scenario が読み直されても、その2つは
 * 変わらないので effect が動き直さず、**古い人数が確定値の顔で残った**。
 *
 * 試算の元になる値を1つの鍵にまとめる。保存後の再読込で中身が変われば
 * 鍵も変わるので、鍵を effect の依存にすれば設定変更のたびに取り直せる。
 * 名前・説明・フォルダのように試算へ影響しない項目は鍵に入れない。
 * 入れてしまうと関係ない保存でも取り直しが走り、画面がちらつく。
 */
export function scenarioSimulationKey(
  scenario: Pick<
    ScenarioWithSteps,
    'id' | 'deliveryMode' | 'lineAccountId' | 'audienceCondition' | 'allowConcurrent' | 'triggerType' | 'steps'
  > | null,
  /** 開始のきっかけの数。WEB229：同じ数のまま中身を変えたときも鍵が変わるよう、版つきの文字も受ける。 */
  triggerCount: number | string | null,
): string {
  if (!scenario) return ''
  return JSON.stringify({
    scenarioId: scenario.id,
    deliveryMode: scenario.deliveryMode ?? 'relative',
    account: scenario.lineAccountId,
    audience: scenario.audienceCondition ?? null,
    allowConcurrent: scenario.allowConcurrent ?? null,
    triggerType: scenario.triggerType,
    triggerCount,
    steps: [...scenario.steps]
      .sort((a, b) => a.stepOrder - b.stepOrder)
      .map((step) => [
        step.id,
        step.stepOrder,
        step.delayMinutes,
        step.offsetDays ?? null,
        step.offsetMinutes ?? null,
        step.deliveryTime ?? null,
        step.targetCondition ?? null,
        step.isDraft === true,
      ]),
  })
}

/**
 * 今の設定の鍵に合う試算だけを返す。
 *
 * 設定が変わって鍵が合わなくなった旧結果は null（=「取り直し中」）として
 * 扱う。古い人数を確定値として画面へ出さないための門番。
 */
export function simulationForKey(
  result: ScenarioSimulationResult | null,
  key: string,
): ScenarioSimulation | null {
  if (!key || !result || result.key !== key) return null
  return result.value
}
