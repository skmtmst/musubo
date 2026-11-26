// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { Steps } from '@/components/templates/steps'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const STEPS = readFileSync(join(HERE, '../../../components/templates/steps.tsx'), 'utf8')
const FORM = readFileSync(join(HERE, '../../../components/broadcasts/broadcast-form.tsx'), 'utf8')

/* #973 U048: 段名を狭い幅へ無理に押し込み、折り返しで読めなくしない。 */
afterEach(cleanup)

describe('配信作成の手順表示（#973 U048）', () => {
  it('現在の段と全段の名前を描画し、省略される名前も全文を読める', () => {
    const labels = ['基本設定', '配信対象', 'メッセージ', '配信日時', '確認']
    render(React.createElement(Steps, {
      label: '配信作成の進み',
      currentKey: '2',
      steps: labels.map((label, index) => ({ key: String(index + 1), label, state: index === 0 ? 'done' as const : 'todo' as const })),
    }))
    const nav = screen.getByRole('navigation', { name: '配信作成の進み' })
    expect(within(nav).getAllByRole('listitem')).toHaveLength(5)
    expect(nav.querySelector('[aria-current="step"]')?.textContent).toContain(labels[1])
    for (const label of labels) {
      expect(within(nav).getByText(label)).toBeTruthy()
      expect(within(nav).getByTitle(label)).toBeTruthy()
    }
    expect(nav.querySelectorAll('[data-step-dot]')).toHaveLength(5)
  })
  it('済みの段へ戻れ、次は現在の下の操作から進む', () => {
    expect(STEPS).toContain("state === 'done' || state === 'attention'")
    expect(STEPS).toContain('step.onSelect?.()')
    expect(FORM).toContain('goToStep(stepOrder[Math.min(currentStepIndex + 1, stepOrder.length - 1)])')
    expect(FORM).toContain("currentStep !== 'confirm'")
  })
  it('広い幅では同じ現役の共通部品へ5段とURLの現在地を渡す', () => {
    expect(FORM).toContain('label="配信作成の進み" unavailableReason="前の手順を完了してください" steps={steps} currentKey={currentStep ?? undefined}')
    expect(STEPS).toContain('<ol')
    expect(STEPS).toContain('aria-current={isCurrent')
  })
})
