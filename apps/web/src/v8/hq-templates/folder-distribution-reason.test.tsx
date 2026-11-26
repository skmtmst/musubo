// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FolderDistributionDialog from './folder-distribution-dialog'

afterEach(cleanup)

it('配るものとアカウントを選ぶまで理由を示し、選ぶと確認に進める', () => {
  const confirm = vi.fn()
  render(<FolderDistributionDialog name="見本" templates={[{ id: 't', name: '案内', template_type: 'template', kind: 'message' }] as never} accounts={[{ id: 'a', name: '見本店' }] as never} accountFolders={{ folders: [], membership: new Map(), failed: false }} busy={false} onCancel={() => {}} onConfirm={confirm} />)
  expect(screen.getByText('配るアカウントを選んでください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: '案内' }))
  expect(screen.getByText('配るテンプレートを選んでください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: '案内' }))
  fireEvent.click(screen.getByRole('checkbox', { name: /見本店/ }))
  expect(screen.queryByText('配るアカウントを選んでください。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /1 件を 1 アカウントへ配る/ }))
  expect(confirm).toHaveBeenCalledTimes(1)
})
