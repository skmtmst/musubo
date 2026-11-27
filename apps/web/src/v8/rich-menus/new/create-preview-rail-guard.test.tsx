// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPreviewRail } from './create-preview-rail'

afterEach(cleanup)

describe('rich-menus/new/create-preview-rail の面不一致・非有限人数ガード', () => {
  it('選択中の面が現在のページに存在しないとき「@ 面 0」を出さず未選択の案内を出す', () => {
    const props = {
      step: 'buttons',
      host: undefined,
      activePage: {
        id: 'page-2',
        name: 'タブ2',
        areas: [{ id: 'area-b', label: '問い合わせ', actionType: 'uri', actionData: {}, intent: 'url', boundsX: 0, boundsY: 0, boundsWidth: 100, boundsHeight: 100 }],
      },
      selectedArea: {
        id: 'area-from-page-1',
        label: '',
        actionType: 'uri',
        actionData: {},
        intent: 'url',
        boundsX: 0,
        boundsY: 0,
        boundsWidth: 100,
        boundsHeight: 100,
      },
      configuredCount: 0,
      totalAreaCount: 1,
      pages: [],
      tabCount: 1,
      previewImageUrl: null,
      renderLinePreview: () => <div />,
    } as unknown as Parameters<typeof renderPreviewRail>[0]

    const { container } = render(<>{renderPreviewRail(props)}</>)
    expect(container.textContent).not.toContain('@ ')
    expect(screen.getByText('面を選ぶと、ここに数が出ます。')).toBeTruthy()
  })

  it('統括の友だち合計が NaN のときは「— 人」にせず「—」で未取得を表す', () => {
    const props = {
      step: 'audience',
      audience: 'all',
      host: { selectedCount: 2, friendTotal: Number.NaN },
      hqPreview: null,
      configuredCount: 0,
      totalAreaCount: 1,
      pages: [],
      tabCount: 0,
      previewImageUrl: null,
      renderLinePreview: () => <div />,
    } as unknown as Parameters<typeof renderPreviewRail>[0]

    const { container } = render(<>{renderPreviewRail(props)}</>)
    expect(container.textContent).not.toContain('— 人')
    expect(container.textContent).toContain('—')
  })
})
