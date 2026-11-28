// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/shared/condition-builder', () => ({
  default: () => <div data-testid="condition-builder" />,
}))

import { renderAudienceStep } from './create-audience-step'

function makeProps(overrides: Partial<Parameters<typeof renderAudienceStep>[0]> = {}): Parameters<typeof renderAudienceStep>[0] {
  return {
    aggregateOnly: false,
    audience: 'targeted',
    canOperate: true,
    conditionCount: 2,
    conditionEmpty: false,
    conditionUnsaved: true,
    currentDefaultMenu: undefined,
    defaultOpen: true,
    editGroupId: 'group-1',
    host: undefined,
    orderRows: [],
    renderHqAudience: () => null,
    setAudience: vi.fn(),
    setDefaultOpen: vi.fn(),
    setPriorityInput: vi.fn(),
    setPriorityOpen: vi.fn(),
    setTargetingCondition: vi.fn(),
    setTargetingPriority: vi.fn(),
    targetedMenus: [],
    targetingCondition: null,
    targetingPriority: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('create-audience-step 異常な条件数と表示順入力の防御', () => {
  it('条件数が負数や NaN のとき「-1件」「—件」と出さず確認不能と表示する', () => {
    const view = render(<>{renderAudienceStep(makeProps({ conditionCount: -1, conditionUnsaved: true }))}</>)
    expect(screen.getByText('条件数を確認できません（未保存）')).toBeTruthy()
    expect(screen.queryByText(/条件 -1件/)).toBeNull()

    view.rerender(<>{renderAudienceStep(makeProps({ conditionCount: Number.NaN, conditionUnsaved: false }))}</>)
    expect(screen.getByText('保存済みの条件数を確認できません')).toBeTruthy()
    expect(screen.queryByText(/—件/)).toBeNull()
  })

  it('targetingPriority が NaN や負数のとき「順番を変更する」で NaN や負の値を入力欄へ入れない', () => {
    const setPriorityInput = vi.fn()
    const setPriorityOpen = vi.fn()
    const view = render(
      <>{renderAudienceStep(makeProps({ targetingPriority: Number.NaN, setPriorityInput, setPriorityOpen }))}</>,
    )

    fireEvent.click(screen.getByRole('button', { name: '順番を変更する' }))
    expect(setPriorityInput).toHaveBeenLastCalledWith('')
    expect(setPriorityOpen).toHaveBeenLastCalledWith(true)

    view.rerender(
      <>{renderAudienceStep(makeProps({ targetingPriority: -2, setPriorityInput, setPriorityOpen }))}</>,
    )
    fireEvent.click(screen.getByRole('button', { name: '順番を変更する' }))
    expect(setPriorityInput).toHaveBeenLastCalledWith('')

    view.rerender(
      <>{renderAudienceStep(makeProps({ targetingPriority: 2, setPriorityInput, setPriorityOpen }))}</>,
    )
    fireEvent.click(screen.getByRole('button', { name: '順番を変更する' }))
    expect(setPriorityInput).toHaveBeenLastCalledWith('3')
  })
})
