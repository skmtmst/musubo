// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { renderPreviewRail } from './create-preview-rail'

afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__'])('未対応の参照 %s を配布前に表示する', kind => {
  const context = {
    activePage: null, audience: 'all', conditionEmpty: false, conditionUnsaved: false,
    configuredCount: 0, currentDefaultMenu: undefined, group: null, host: { selectedCount: 1 },
    hqPreview: { references: [{ kind, sourceId: 'ref-1', name: '見本', availableAccountCount: 1, totalAccountCount: 1 }] },
    pages: [], previewImageUrl: null, renderLinePreview: () => <div />, selectedArea: null,
    step: 'buttons', tabCount: 0, targetPreview: null, targetPreviewError: '', targetPreviewLoading: false, totalAreaCount: 0,
  } as unknown as Parameters<typeof renderPreviewRail>[0]
  render(renderPreviewRail(context))
  expect(screen.getByText('参照「見本」')).toBeTruthy()
  expect(screen.getByText('1 / 1')).toBeTruthy()
})
