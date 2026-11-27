// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import NameTipHost from './name-tip'
import IconButton from './icon-button'
import TagPill from './tag-pill'
import Select from './select'
import { EntityPickerSummary } from './entity-picker'
import Toggle from './toggle'
import ReorderHandle from './reorder-handle'
import { AttachmentRow } from './file-drop'

const reason = '閲覧のみのため変更できません'
const options = [{ value: 'a', label: '選択中' }]
const examples = [
  { name: '印の操作', render: (lockedReason?: string) => <IconButton aria-label="印の操作" lockedReason={lockedReason}><svg /></IconButton> },
  { name: '札を外す', render: (lockedReason?: string) => <TagPill name="札" onRemove={() => {}} lockedReason={lockedReason} /> },
  { name: '並び順', nameTip: false, render: (lockedReason?: string) => <Select aria-label="並び順" iconOnly options={options} value="a" onChange={() => {}} lockedReason={lockedReason} /> },
  { name: '対象：変更する', render: (lockedReason?: string) => <EntityPickerSummary label="対象" noun="対象" name="選択中" onOpen={() => {}} lockedReason={lockedReason} /> },
  { name: '通知', render: (lockedReason?: string) => <Toggle label="通知" checked onChange={() => {}} lockedReason={lockedReason} /> },
  { name: '札を並び替え。上下キーで移動', render: (lockedReason?: string) => <ReorderHandle label="札" onPointerDown={() => {}} onMove={() => {}} lockedReason={lockedReason} /> },
  { name: '「資料」を選び直す', render: (lockedReason?: string) => <AttachmentRow name="資料" status="error" errorText="読めませんでした" onRetry={() => {}} lockedReason={lockedReason} /> },
  { name: '「資料」を外す', render: (lockedReason?: string) => <AttachmentRow name="資料" onRemove={() => {}} lockedReason={lockedReason} /> },
]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it.each(examples)('$name は名前の吹き出しを保ち、権限の理由と重ねない', example => {
  const { rerender } = render(<><NameTipHost />{example.render()}</>)
  let control = screen.getByLabelText(example.name)
  expect(control.hasAttribute('data-no-name-tip')).toBe(false)
  fireEvent.pointerOver(control, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(400) })
  expect(screen.queryAllByRole('tooltip').map(node => node.textContent)).toEqual('nameTip' in example && example.nameTip === false ? [] : [example.name])
  fireEvent.pointerOut(control, { relatedTarget: document.body })
  rerender(<><NameTipHost />{example.render(reason)}</>)
  control = screen.getByLabelText(example.name)
  expect(control.getAttribute('aria-disabled')).toBe('true')
  fireEvent.pointerEnter(control, { pointerType: 'mouse' })
  fireEvent.pointerOver(control, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(400) })
  expect(screen.getAllByRole('tooltip').map(node => node.textContent)).toEqual([reason])
  expect(control.hasAttribute('data-no-name-tip')).toBe(true)
  fireEvent.pointerLeave(control, { pointerType: 'mouse' })
  fireEvent.pointerOut(control, { relatedTarget: document.body })
  act(() => { control.focus(); vi.advanceTimersByTime(400) })
  expect(screen.getAllByRole('tooltip').map(node => node.textContent)).toEqual([reason])
  act(() => control.blur())
  rerender(<><NameTipHost />{example.render()}</>)
  control = screen.getByLabelText(example.name)
  expect(control.hasAttribute('data-no-name-tip')).toBe(false)
  fireEvent.pointerOver(control, { pointerType: 'mouse' })
  act(() => { vi.advanceTimersByTime(400) })
  expect(screen.queryAllByRole('tooltip').map(node => node.textContent)).toEqual('nameTip' in example && example.nameTip === false ? [] : [example.name])
})
