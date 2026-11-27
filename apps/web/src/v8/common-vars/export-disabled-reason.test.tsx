// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useVarsExportPanel } from './export-panel'

vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, commonVars: { ...actual.api.commonVars, listExports: vi.fn().mockResolvedValue({ success: true, data: [] }) } } }
})

afterEach(cleanup)
function Panel({ accountId }: { accountId: string | null }) {
  const panel = useVarsExportPanel({ accountId, folderId: null })
  return <>{panel.action}{panel.status}</>
}
it('アカウントがないと書き出せない理由を示し、選ぶと操作できる', () => {
  const view = render(<Panel accountId={null} />)
  expect(screen.getByText('上のバーでLINE公式アカウントを選んでください。')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement).disabled).toBe(true)
  view.rerender(<Panel accountId="example" />)
  expect(screen.queryByText('上のバーでLINE公式アカウントを選んでください。')).toBeNull()
  expect((screen.getByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement).disabled).toBe(false)
})
