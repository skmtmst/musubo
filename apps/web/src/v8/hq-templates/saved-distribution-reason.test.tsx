// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SavedDistributionDialog from './saved-distribution-dialog'

afterEach(cleanup)

it('配る先がない理由を示し、選択後に配布を進められる', () => {
  const distribute = vi.fn()
  const props = { accounts: [{ id: 'a', name: '見本店' }], folders: { folders: [], membership: new Map(), failed: false }, selected: [] as string[], onChange: vi.fn(), filter: 'all', onFilter: vi.fn(), search: '', onSearch: vi.fn(), received: [], receivedFailed: false, busy: false, onLater: vi.fn(), onDistribute: distribute }
  const view = render(<SavedDistributionDialog {...props} />)
  expect(screen.getByText('配るアカウントを選んでください。')).toBeTruthy()
  view.rerender(<SavedDistributionDialog {...props} selected={['a']} />)
  expect(screen.queryByText('配るアカウントを選んでください。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '1 アカウントへ配る' }))
  expect(distribute).toHaveBeenCalledTimes(1)
})
