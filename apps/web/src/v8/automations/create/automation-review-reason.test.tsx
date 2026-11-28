// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AutomationReview } from './automation-review'
vi.mock('@/components/shared/friend-picker-field', () => ({ default: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange('example')}>見本の友だちを選ぶ</button> }))
afterEach(cleanup)
it('下書きと試す友だちがそろうまで理由を示す', () => {
  const ask = vi.fn()
  const props = { ruleSentence: '見本', previewFailed: false, previewCount: null, totalForDraft: null, savedDraft: null, selectedAccountId: 'example', previewRefreshing: false, refreshAudiencePreview: vi.fn(), testFriendId: '', setTestFriendId: vi.fn(), canEdit: true, askOnePersonTest: ask, saving: false, testing: false, preparingTest: false, testConfirmation: null, draftActions: () => [], testTicketRef: { current: 0 }, setTestConfirmation: vi.fn(), runOnePersonTest: vi.fn(), testRun: null, guarded: vi.fn(), router: { push: vi.fn() }, refreshTestRun: vi.fn(), saveOutcome: 'idle', publishedRuleId: null, existingError: false, setExistingRetry: vi.fn(), hasSameTrigger: false, usedScenarioNames: [], usedTagNames: [], usedCommonActionNames: [] }
  const view = render(<AutomationReview {...props as unknown as React.ComponentProps<typeof AutomationReview>} />)
  expect(screen.getByText('下書きを保存すると試せます。')).toBeTruthy()
  view.rerender(<AutomationReview {...{ ...props, savedDraft: {} } as unknown as React.ComponentProps<typeof AutomationReview>} />)
  expect(screen.getByText('試す友だちを選んでください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '見本の友だちを選ぶ' }))
  expect(props.setTestFriendId).toHaveBeenCalledWith('example')
  view.rerender(<AutomationReview {...{ ...props, savedDraft: {}, testFriendId: 'example' } as unknown as React.ComponentProps<typeof AutomationReview>} />)
  expect(screen.queryByText('試す友だちを選んでください。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '1人で試す' }))
  expect(ask).toHaveBeenCalledTimes(1)
})
