// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { emptyLayout } from '@line-crm/shared'
import { FormPhone } from './phone'

afterEach(cleanup)
it('見本の画像の読み込みに失敗しても、別の画像へ替えると表示する', () => {
  const layout = emptyLayout()
  layout.header = [{ id: 'image', kind: 'image', mediaUrl: 'https://example.test/old.png', alt: '見本画像' } as never]
  const props = { pageIndex: 0, accountName: '見本', bookingMenus: [] }
  const view = render(<FormPhone {...props} layout={layout} />)
  fireEvent.error(screen.getByAltText('見本画像'))
  expect(screen.getByLabelText('画像（読み込めません）')).toBeTruthy()
  const next = { ...layout, header: [{ id: 'image', kind: 'image', mediaUrl: 'https://example.test/new.png', alt: '見本画像' } as never] }
  view.rerender(<FormPhone {...props} layout={next} />)
  expect(screen.getByAltText('見本画像').getAttribute('src')).toBe('https://example.test/new.png')
})
