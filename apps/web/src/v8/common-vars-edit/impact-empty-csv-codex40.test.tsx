// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ImpactRows } from './edit-impact'
afterEach(cleanup)
it('書き出す使用先がない理由を表示してCSVを実行しない', () => {
  const exportCsv=vi.fn()
  render(<ImpactRows impact={{canSave:true,total:0,items:[],unavailableReferences:[],checkedAt:'2026-11-27T00:00:00Z'} as never} onExportCsv={exportCsv} />)
  expect(screen.getByText('書き出す使用先がありません。')).toBeTruthy()
  const button=screen.getByRole('button',{name:'この一覧をCSVで'}) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(exportCsv).not.toHaveBeenCalled()
})
