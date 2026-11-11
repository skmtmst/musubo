// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FirstStepsCard, summarizeFirstSteps } from './first-steps'
import { SetupTasks } from '@/v8/onboarding/public/setup-card/index'
import { questionsFor, summarizeSetup, type StyleState } from '@/v8/onboarding/model'
import { buildStepsFromApi } from '@/v8/settings/getting-started/steps'

afterEach(cleanup)
const keys = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage']
const steps = buildStepsFromApi(keys.map(key => ({ key, state: key === 'accounts' || key === 'featureSet' ? 'done' as const : 'todo' as const, href: '/getting-started', reason: null })) as Parameters<typeof buildStepsFromApi>[0])

it.each(['restaurant', 'salon', 'consult', 'lesson', 'standard', 'ec'] as const)('%sは基本の数と線を1つにし、済んだ番号と残りの設定を残す', style => {
  const state: StyleState = { style, version: 1, styleSelected: true, answers: Object.fromEntries(questionsFor(style).map(q => [q.key, { mode: 'later' }])) }
  const summary = summarizeFirstSteps(steps, style)
  const setup = summarizeSetup(state, [], [{ target_id: 'notice', kind: 'automation', status: 'draft', is_sample: 1, draftRevision: 'draft' }])
  render(<FirstStepsCard summary={summary} folded={false} onToggle={vi.fn()} setupTasks={<SetupTasks heading summary={setup} onOpenStep={vi.fn()} />} />)
  const card = screen.getByRole('region', { name: 'はじめにやること' })
  expect(within(card).getAllByRole('progressbar')).toHaveLength(1)
  const progress = within(card).getByRole('progressbar')
  expect(progress.getAttribute('aria-valuenow')).toBe(String(summary.done))
  expect(progress.getAttribute('aria-valuemax')).toBe(style === 'restaurant' ? '8' : '7')
  expect(card.textContent).not.toMatch(/質問 \d|済み \d+件/)
  expect(within(card).getByText('入ったお知らせを動かす')).toBeTruthy()
  expect(within(card).getByRole('button', { name: '中身を見る' })).toBeTruthy()
  expect(within(card).getByRole('button', { name: '設定を確認する' })).toBeTruthy()
  const rows = card.querySelectorAll('#first-steps-list > li')
  expect(rows).toHaveLength(summary.total)
  summary.steps.forEach((step, index) => {
    expect(rows[index]?.querySelector('[data-setup-step-label]')?.textContent).toContain(`${step.ordinal}. `)
    if (step.done) expect(rows[index]?.querySelector('[data-step-mark="done"]')).not.toBeNull()
  })
})
