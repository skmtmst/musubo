// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DetailHead, WizardSteps } from './chrome'
import type { StepKey } from './helpers'

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/components/templates/steps', () => ({
  Steps: ({
    steps,
  }: {
    steps: ReadonlyArray<{ key?: string; label: string; state: string; onSelect?: () => void }>
  }) => (
    <div>
      {steps.map((step) => (
        <button
          key={step.key ?? step.label}
          type="button"
          data-has-select={String(Boolean(step.onSelect))}
          onClick={() => step.onSelect?.()}
        >
          {step.label}
        </button>
      ))}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
})

describe('webinar-edit chrome の手順選択ガードと件数表示', () => {
  it('WizardSteps は済みの段（現在段以外）だけを選択可能にし、現在段と未到達段へは onSelect を渡さない', () => {
    const onSelect = vi.fn()
    const stateOf = (key: StepKey): 'done' | 'current' | 'todo' => {
      if (key === 'basic') return 'done'
      if (key === 'video') return 'current'
      return 'todo'
    }

    render(<WizardSteps current="video" stateOf={stateOf} onSelect={onSelect} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons[0].getAttribute('data-has-select')).toBe('true')
    expect(buttons[1].getAttribute('data-has-select')).toBe('false')
    expect(buttons[2].getAttribute('data-has-select')).toBe('false')

    fireEvent.click(buttons[1])
    fireEvent.click(buttons[2])
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(buttons[0])
    expect(onSelect).toHaveBeenCalledWith('basic')
  })

  it('DetailHead は参加者数が非有限値のときに NaN を表示しない', () => {
    const onSelect = vi.fn()

    render(
      <DetailHead
        title="セミナー"
        subtitle="説明"
        current="participants"
        participantsCount={Number.NaN}
        onSelect={onSelect}
      />,
    )

    const tab = screen.getByRole('tab', { name: '参加者', selected: true })
    expect(tab.textContent).toBe('参加者')
    fireEvent.click(tab)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
