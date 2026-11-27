// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_DEFINITION, EMPTY_RULE } from './editor-model'
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/components/shared/condition-builder', () => ({ default: () => null }))
import { RoutesStep } from './editor-basic-routes'
afterEach(cleanup)
it.each([{ operator: 'AND', rules: [null] }, { operator: 'AND', rules: [], groups: [null] }, { operator: 'AND', rules: [], groups: [{ operator: 'OR', rules: [null] }] }])('壊れた条件を作り直すよう案内する %#', (condition) => {
  render(<RoutesStep rule={EMPTY_RULE} definition={{ ...EMPTY_DEFINITION, friendCondition: JSON.stringify(condition) }} setDefinition={vi.fn()} options={{ routes: [], tags: [], scenarios: [], folders: [] }} routeUses={new Map()} toggleRoute={vi.fn()} canEdit />)
  expect(screen.getByRole('alert').textContent).toContain('条件を作り直してください')
  expect(screen.getByRole('alert').textContent).toContain('今は配信を止めています')
  expect(screen.getByText('友だち条件：確認できません')).toBeTruthy()
})
