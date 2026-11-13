// @vitest-environment happy-dom
/*
 * S4-OR（動作条件の証明）: 終了後アクションの条件で、空の or だけ足して
 * 保存しても update の口は呼ばれず、不足の案内が出る。
 * 中身を入れたかたまり・条件なし（null）は保存できる。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActionEditor from './action-editor'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

const net = vi.hoisted(() => ({
  updates: [] as Array<{ scenarioId: string; actionId: string; patch: unknown }>,
}))

const SEED_ACTION = {
  id: 'a1',
  hook: 'scenario_completed',
  stepId: null,
  choiceIndex: null,
  actionType: 'tag',
  config: { op: 'add', tagIds: [] },
  condition: null,
  repeatOnRefire: true,
  sortOrder: 0,
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: {}, enabled: () => true }),
}))

vi.mock('./scenario-reference-data', () => ({
  scenarioReferenceData: {
    tags: async () => ({ success: true as const, data: [] }),
    friendFields: async () => ({ success: true as const, data: [] }),
    supportMarks: async () => ({ success: true as const, data: [] }),
    scenarios: async () => ({ success: true as const, data: [] }),
    commonVars: async () => ({ success: true as const, data: [] }),
    templates: async () => ({ success: true as const, data: [] }),
    reminders: async () => ({ success: true as const, data: [] }),
    events: async () => ({ success: true as const, data: [] }),
  },
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      scenarios: {
        list: async () => ({ success: true as const, data: [] }),
        actions: {
          list: async () => ({ success: true as const, data: [SEED_ACTION] }),
          update: async (scenarioId: string, actionId: string, patch: unknown) => {
            net.updates.push({ scenarioId, actionId, patch })
            return { success: true as const, data: {} }
          },
        },
        getDraft: async () => ({ success: true as const, data: null }),
        saveDraft: async () => ({ success: true as const, data: { version: 1 } }),
      },
      tags: { list: async () => ({ success: true as const, data: [] }) },
      friendFields: { list: async () => ({ success: true as const, data: [] }) },
      supportMarks: { list: async () => ({ success: true as const, data: [] }) },
      segments: { count: async () => ({ success: true as const, data: { count: 0 } }) },
    },
  }
})

afterEach(() => {
  cleanup()
  net.updates = []
})

async function renderEditor() {
  await act(async () => {
    render(
      <ActionEditor
        scenarioId="sc-1"
        hook="scenario_completed"
        title="テストのあと"
        onClose={() => {}}
      />,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function openCondition() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '条件OFF' }))
  })
}

function orAddButton() {
  return screen.getByRole('button', { name: 'いずれか条件のかたまりを足す' })
}

function kindPickers() {
  return screen.getAllByRole('button', { name: '追加する条件を選ぶ' })
}

function pickKind(field: HTMLElement, query: string) {
  fireEvent.click(field)
  const dialog = screen.getByRole('dialog', { name: '条件を選ぶ', hidden: true })
  fireEvent.click(within(dialog).getByRole('radio', { name: query, hidden: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '条件を足す', hidden: true }))
}

async function saveCondition() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '条件を保存する' }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('S4-OR 動作の条件は空のかたまりを黙って保存しない', () => {
  it('条件を編集して戻るとき、未保存の条件を破棄する前に確認する', async () => {
    await renderEditor()
    await openCondition()
    fireEvent.click(orAddButton())
    fireEvent.click(screen.getByRole('button', { name: '戻る' }))
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('動作の条件への変更')
    expect(screen.getByRole('button', { name: '条件を保存する' })).toBeTruthy()
  })

  it('条件を編集して別画面へ移るとき、入力を残して確認する', async () => {
    window.history.replaceState(null, '', '/scenarios')
    await renderEditor(); await openCondition()
    fireEvent.click(orAddButton())
    const link = document.createElement('a'); link.href = '/events'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '条件を保存する' })).toBeTruthy()
    link.remove()
  })
  it('空の or だけ足して保存しても口は呼ばれず、不足の案内が出る', async () => {
    await renderEditor()
    await openCondition()
    expect(kindPickers()).toHaveLength(1)
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    expect(kindPickers()).toHaveLength(2)

    await saveCondition()

    expect(net.updates).toHaveLength(0)
    expect(screen.getByText(/空の「いずれか」の条件のかたまりがあります/)).toBeTruthy()
  })

  it('かたまりに条件を入れると保存でき、かたまりごと送られる', async () => {
    await renderEditor()
    await openCondition()
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    pickKind(kindPickers()[1], '行動スコア')
    await saveCondition()

    expect(net.updates).toHaveLength(1)
    const sent = (net.updates[0].patch as { condition: { groups: { rules: { type: string }[] }[] } })
      .condition
    expect(sent.groups).toHaveLength(1)
    expect(sent.groups[0].rules[0].type).toBe('score_range')
  })

  it('戻ると下書きは捨てられ、口は呼ばれない', async () => {
    await renderEditor()
    await openCondition()
    await act(async () => {
      fireEvent.click(orAddButton())
    })
    expect(kindPickers()).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '戻る' }))
    })
    const confirmation = await screen.findByRole('dialog', { name: '保存していない変更があります' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '保存せずに移る' }))

    expect(net.updates).toHaveLength(0)
    // 開き直すと空のかたまりは残っていない（動作の保存値は null のまま）。
    await openCondition()
    expect(kindPickers()).toHaveLength(1)
  })
})
