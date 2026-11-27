// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Scenario, ScenarioStep } from '@line-crm/shared'
import type { ScenarioSimulation } from '@/lib/api'
import { scenarioSimulationKey, simulationForKey } from './scenario-simulation-refresh'

afterEach(cleanup)
const base = { id: 's1', deliveryMode: 'relative', lineAccountId: 'a', audienceCondition: null, allowConcurrent: true, triggerType: 'friend_add', steps: [] } as unknown as Scenario & { steps: ScenarioStep[] }
const simulation = { scenarioId: 's1', lineAccountId: 'a', computedAt: '', sideEffects: false, audience: { accountTotal: 128, matched: 128, alreadySubscribed: 0, newStartPlanned: 128, excluded: 0 }, steps: [] } as ScenarioSimulation
function Screen() {
  const [scenario, setScenario] = useState(base)
  const [result] = useState(() => ({ key: scenarioSimulationKey(base, 1), value: simulation }))
  const value = simulationForKey(result, scenarioSimulationKey(scenario, 1))
  return <><span>{value ? `${value.audience.newStartPlanned}人` : '試算中'}</span><button onClick={() => setScenario({ ...scenario, deliveryMode: 'elapsed' })}>配信方式を変える</button><button onClick={() => setScenario({ ...scenario, id: 's2' })}>別のシナリオ</button></>
}
it('配信方式を変えたら以前の試算を表示しない', () => {
  render(<Screen />)
  expect(screen.getByText('128人')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '配信方式を変える' }))
  expect(screen.getByText('試算中')).toBeTruthy()
})
it('別のシナリオへ変えたら以前の試算を表示しない', () => {
  render(<Screen />)
  expect(screen.getByText('128人')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '別のシナリオ' }))
  expect(screen.getByText('試算中')).toBeTruthy()
})
