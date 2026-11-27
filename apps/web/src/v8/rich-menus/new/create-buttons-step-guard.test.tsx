// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Area } from '../../../components/rich-menus/area-types'
import type { Page } from './create-types'

vi.mock('@/components/rich-menus/area-properties', () => ({
  AreaProperties: () => <div data-testid="area-props" />,
}))

vi.mock('@/components/rich-menus/canvas-editor', () => ({
  areaDisplayName: (area: Area, index: number) => area.label?.trim() || `${index + 1}番目のボタン`,
  CanvasEditor: ({
    onSelectArea,
    onUpdateArea,
    onDeleteArea,
  }: {
    onSelectArea: (id: string | null) => void
    onUpdateArea: (id: string, patch: Partial<Area>) => void
    onDeleteArea: (id: string) => void
  }) => (
    <div>
      <button type="button" onClick={() => onSelectArea('ghost-area')}>存在しない面を選ぶ</button>
      <button type="button" onClick={() => onUpdateArea('ghost-area', { label: 'x' })}>存在しない面を更新</button>
      <button type="button" onClick={() => onDeleteArea('ghost-area')}>存在しない面を削除</button>
    </div>
  ),
}))

vi.mock('@/components/shared/segmented', () => ({
  default: ({ onChange }: { onChange: (value: string) => void }) => (
    <div>
      <button type="button" onClick={() => onChange('missing-page')}>存在しないタブへ切替</button>
      <button type="button" onClick={() => onChange('page-2')}>タブ2へ切替</button>
    </div>
  ),
}))

import { renderButtonsStep } from './create-buttons-step'

afterEach(cleanup)

function makeArea(index: number): Area {
  return {
    id: `area-${index}`,
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'message',
    actionData: { text: '' },
    intent: 'text',
    label: '',
    tagIds: [],
    scoreChange: null,
  }
}

function makePage(id: string, areaCount: number): Page {
  return {
    id,
    orderIndex: 0,
    name: id,
    aliasId: '',
    lineRichmenuId: null,
    imageR2Key: null,
    imageContentType: null,
    areas: Array.from({ length: areaCount }, (_, i) => makeArea(i)),
  }
}

const dummyFields = {
  bind: () => ({}),
  error: () => undefined,
  countIn: () => 0,
} as unknown as Parameters<typeof renderButtonsStep>[0]['fields']

describe('renderButtonsStep の27面目以降の記号表示と存在しないIDの守り', () => {
  it('27番目の面（index 26）でも記号「[」を出さず「面 27」として表示する', () => {
    const page1 = makePage('page-1', 27)
    const target = page1.areas[26]!

    render(
      <>
        {renderButtonsStep({
          activePage: page1,
          addArea: vi.fn(),
          areaActionSummary: () => '',
          deleteArea: vi.fn(),
          fields: dummyFields,
          forms: [],
          goToStep: vi.fn(),
          group: null,
          host: undefined,
          pageImageUrl: null,
          pages: [page1],
          publishLabelErrors: dummyFields,
          selectedArea: target,
          selectedAreaId: target.id,
          setActivePageId: vi.fn(),
          setSelectedAreaId: vi.fn(),
          size: 'large',
          tags: [],
          templates: [],
          trackedLinks: [],
          updateArea: vi.fn(),
        })}
      </>,
    )

    expect(screen.getByText('面 27「27番目のボタン」の動き')).toBeTruthy()
    expect(screen.queryByText(/面 \[/)).toBeNull()
  })

  it('存在しないタブID・面IDの切替や操作は無視し、実在するタブ切替だけ反映する', () => {
    const page1 = makePage('page-1', 2)
    const page2 = makePage('page-2', 1)
    page2.areas[0]!.id = 'p2-area-0'

    const setActivePageId = vi.fn()
    const setSelectedAreaId = vi.fn()
    const updateArea = vi.fn()
    const deleteArea = vi.fn()

    render(
      <>
        {renderButtonsStep({
          activePage: page1,
          addArea: vi.fn(),
          areaActionSummary: () => '',
          deleteArea,
          fields: dummyFields,
          forms: [],
          goToStep: vi.fn(),
          group: null,
          host: undefined,
          pageImageUrl: null,
          pages: [page1, page2],
          publishLabelErrors: dummyFields,
          selectedArea: page1.areas[0]!,
          selectedAreaId: page1.areas[0]!.id,
          setActivePageId,
          setSelectedAreaId,
          size: 'large',
          tags: [],
          templates: [],
          trackedLinks: [],
          updateArea,
        })}
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: '存在しないタブへ切替' }))
    fireEvent.click(screen.getByRole('button', { name: '存在しない面を選ぶ' }))
    fireEvent.click(screen.getByRole('button', { name: '存在しない面を更新' }))
    fireEvent.click(screen.getByRole('button', { name: '存在しない面を削除' }))

    expect(setActivePageId).not.toHaveBeenCalled()
    expect(setSelectedAreaId).not.toHaveBeenCalled()
    expect(updateArea).not.toHaveBeenCalled()
    expect(deleteArea).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'タブ2へ切替' }))
    expect(setActivePageId).toHaveBeenCalledWith('page-2')
    expect(setSelectedAreaId).toHaveBeenCalledWith('p2-area-0')
  })
})
