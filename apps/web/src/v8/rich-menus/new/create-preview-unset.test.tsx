// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { renderPreviewRail } from './create-preview-rail'
import { useMenuShapeDraft } from './use-menu-shape-draft'
import { TEMPLATES } from '@/lib/rich-menu-templates'

afterEach(cleanup)

it('初期のレイアウトは６面で、タブの追加はない', () => {
  const { result } = renderHook(() => useMenuShapeDraft())
  const template = TEMPLATES.find(item => item.key === result.current.templateKey)
  expect(template?.areas).toHaveLength(6)
  expect(result.current.tabCount).toBe(0)
})

it.each([1, 3, 6])('未設定の面 %i 個は件数を短く示し、警告色にしない', (count) => {
  const props = { step: 'shape', host: null, configuredCount: 0, totalAreaCount: count, pages: [], tabCount: 0, previewImageUrl: null, renderLinePreview: () => <div /> } as unknown as Parameters<typeof renderPreviewRail>[0]
  render(<>{renderPreviewRail(props)}</>)
  const value = screen.getByText(`未設定 ${count}`)
  expect(value.className).not.toMatch(/warn/i)
})
