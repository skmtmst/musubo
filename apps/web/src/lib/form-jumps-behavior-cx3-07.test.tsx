// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyLayout, type FormInputBlock } from '@line-crm/shared'
import { EMPTY_REFS } from '@/components/forms/form-refs'
import { ContentTab } from '@/v8/form-edit/content-tab'

vi.mock('next/link', () => ({ default: ({ children, ...rest }: React.ComponentProps<'a'>) => <a {...rest}>{children}</a> }))
vi.mock('@/components/shared/select', () => ({ default: ({ value, onChange, options, ...rest }: { value: string; onChange: (s: string) => void; options: { value: string; label: string }[] }) => <select {...rest} value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
afterEach(cleanup)

it('ページを消す確認で、全ページから向かう選択肢だけを数える', () => {
  const block = (id: string, targets: string[]): FormInputBlock => ({ id, kind: 'input', type: 'radio', name: id, label: '質問', required: false, choiceMode: 'tag', choices: targets.map((target, i) => ({ id: `${id}-${i}`, label: `選択肢${i}`, jumpToSectionId: target })) })
  const first = block('first', ['p2'])
  const second = block('second', ['p1'])
  const third = block('third', ['p1', 'p1', 'p3'])
  const layout = emptyLayout()
  layout.sections = [{ id: 'p1', name: '前半', blocks: [first] }, { id: 'p2', name: '中盤', blocks: [second] }, { id: 'p3', name: '後半', blocks: [third] }]
  const onRemovePage = vi.fn()
  render(<ContentTab layout={layout} page={0} blocks={[first]} refs={EMPTY_REFS} selectedBlockId={null} inputCount={1} accountId="acc" onSelectPage={vi.fn()} onAddPage={vi.fn()} onRenamePage={() => true} onDuplicatePage={vi.fn()} onRemovePage={onRemovePage} onSelectBlock={vi.fn()} onAddBlock={vi.fn()} onPatchBlock={vi.fn()} onMoveBlock={vi.fn()} onDuplicateBlock={vi.fn()} onRemoveBlock={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /ページ「前半」のその他操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'このページを消す' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('このページへの分岐3件は「次へ進む」に戻します。')).toBeTruthy()
  expect(onRemovePage).not.toHaveBeenCalled()
})
