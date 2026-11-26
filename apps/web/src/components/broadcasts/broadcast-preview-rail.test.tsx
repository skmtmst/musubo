// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef, useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BroadcastPreviewRail } from './broadcast-preview-rail'
import styles from './broadcast-form-v8.module.css'

const previewWindow = vi.hoisted(() => ({ hidden: false }))
vi.mock('@/components/shared/dialog', async original => {
  const { default: Dialog } = await original<typeof import('@/components/shared/dialog')>()
  return { default: (props: ComponentProps<typeof Dialog>) => previewWindow.hidden && props.title === 'LINEの見え方' ? null : <Dialog {...props} /> }
})
afterEach(() => { cleanup(); previewWindow.hidden = false })

it('スマホの見本とPCでの差の注記を出し、閉じると焦点を戻す', () => {
  type Props = ComponentProps<typeof BroadcastPreviewRail>
  const toggle = createRef<HTMLButtonElement>()
  function Preview() {
    const [open, setOpen] = useState(true)
    return <><button ref={toggle}>見本を開く</button><BroadcastPreviewRail
      ab={{ hasB: false } as Props['ab']} afterActionVersionId="" audienceDisplayCount={null}
      bubbles={[]} confirmAudienceLabel="未設定" currentStep="message" excludeTagId="" messageButtons={[]}
      openTestDialog={vi.fn(async () => {})} previewCloseRef={createRef<HTMLButtonElement>()} reviewKey="initial" previewConfirmed={false}
      previewOpen={open} previewToggleRef={toggle} publishedActions={[]}
      saving={false} scheduledLabel={null} selectedAccount={null} sendWhenLabel={null}
      setPreviewConfirmed={vi.fn()} setPreviewOpen={setOpen}
      tags={[]} testBlockReason="本文を入れてください" /></>
  }
  const { container } = render(<Preview />)
  expect(screen.queryByRole('group', { name: 'プレビューの端末' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'PC' })).toBeNull()
  expect(container.querySelector(`.${styles.phonePreview}`)).not.toBeNull()
  expect(container.querySelector('[data-line-preview-part="device-frame"]')).not.toBeNull()
  expect(screen.getByText('PC の LINE では見え方が少し変わります')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(container.querySelector('aside')?.hasAttribute('data-open')).toBe(false)
  expect(document.activeElement).toBe(toggle.current)
  expect(screen.getByRole('button', { name: /テストを送る/ }).hasAttribute('disabled')).toBe(true)
})

it('手順 1〜2 は空のスマホではなく、届く人数と内訳（対象・ブロック中で除く・除くタグ）を出す', () => {
  type Props = ComponentProps<typeof BroadcastPreviewRail>
  const props = {
    ab: { hasB: false } as Props['ab'], afterActionVersionId: '', audienceDisplayCount: 1028, bubbles: [],
    confirmAudienceLabel: 'シナリオ購読中', excludeTagId: 'tag-1', messageButtons: [], openTestDialog: vi.fn(async () => {}),
    preflight: { audienceCount: 1028, hiddenExcluded: 0, warnings: [], audience: { matched: 1045, sendable: 1028, evaluatedAt: '2026-10-26T00:00:00Z', representatives: [] }, exclusions: { blocked: 17, hidden: 0, missingDestination: 0, duplicate: 0, paused: null, total: 17 } },
    preflightStatus: 'ready' as const, previewCloseRef: createRef<HTMLButtonElement>(), reviewKey: 'initial', previewConfirmed: false,
    previewOpen: true, previewToggleRef: createRef<HTMLButtonElement>(), publishedActions: [], saving: false, scheduledLabel: null,
    selectedAccount: null, sendWhenLabel: null, setPreviewConfirmed: vi.fn(), setPreviewOpen: vi.fn(),
    tags: [{ id: 'tag-1', name: '休眠' }] as Props['tags'], testBlockReason: '',
  }
  for (const step of ['basic', 'audience'] as const) {
    const view = render(<BroadcastPreviewRail {...props} currentStep={step} />)
    const rail = view.getByRole('complementary', { name: '届く人' })
    expect(rail.textContent).toContain('1,028')
    expect(rail.textContent).toContain('シナリオ購読中1,045 人')
    expect(rail.textContent).toContain('ブロック中で除く− 17 人')
    expect(rail.textContent).toContain('除くタグ休眠')
    expect(within(rail).getByRole('link', { name: /届く人の一覧へ/ }).getAttribute('href')).toBe('/friends')
    expect(view.queryByRole('group', { name: 'プレビューの端末' })).toBeNull()
    cleanup()
  }
  const message = render(<BroadcastPreviewRail {...props} currentStep="message" />)
  expect(message.getByRole('complementary', { name: 'LINEの見え方' })).not.toBeNull()
  cleanup()
  const counting = render(<BroadcastPreviewRail {...props} currentStep="audience" preflight={null} audienceDisplayCount={null} preflightStatus="loading" />)
  const rail = counting.getByRole('complementary', { name: '届く人' })
  expect(rail.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(rail.textContent).toContain('ブロック中で除く—')
})

function ReviewPreview({ hasB = false }: { hasB?: boolean }) {
  type Props = ComponentProps<typeof BroadcastPreviewRail>
  const [confirmed, setConfirmed] = useState(false)
  const [tab, setTab] = useState<'A' | 'B'>('A')
  const [text, setText] = useState('実際の本文')
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setText('書き直した本文')}>本文を直す</button><button onClick={() => setOpen(true)}>狭い幅の見本を開く</button><BroadcastPreviewRail
    ab={{ hasB, tab, setTab, b: [{ id: 'b', type: 'text', content: { text: 'B案の本文' } }] } as Props['ab']}
    afterActionVersionId="" audienceDisplayCount={null} bubbles={[{ id: 'a', type: 'text', content: { text } }]} confirmAudienceLabel="全員" currentStep="message" excludeTagId="" messageButtons={[]}
    openTestDialog={async () => { throw Error('送信しない') }} preflight={null} preflightStatus="idle" previewCloseRef={createRef<HTMLButtonElement>()} reviewKey={JSON.stringify([text, hasB])} previewConfirmed={confirmed}
    previewOpen={open} previewToggleRef={createRef<HTMLButtonElement>()} publishedActions={[]} saving={false} scheduledLabel={null} selectedAccount={null} sendWhenLabel={null}
    setPreviewConfirmed={setConfirmed} setPreviewOpen={setOpen} tags={[]} testBlockReason="" /></>
}

it('見本の窓が出ない場合はボタンを押しても確認済みにしない', () => {
  previewWindow.hidden = true
  render(<ReviewPreview />)
  const check = screen.getByRole('checkbox', { name: 'LINEプレビューが未確認です' }) as HTMLInputElement
  fireEvent.click(screen.getByRole('button', { name: '配信イメージを見る' }))
  expect(screen.queryByRole('dialog', { name: 'LINEの見え方' })).toBeNull()
  expect(check.checked).toBe(false)
})

it('A/Bは両案を開いてから確認し、案の切替では保持し、本文の変更で両方解除する', () => {
  render(<ReviewPreview hasB />)
  const check = screen.getByRole('checkbox', { name: 'LINEプレビューが未確認です' }) as HTMLInputElement
  expect(check.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '配信イメージを見る' }))
  const dialog = screen.getByRole('dialog', { name: 'LINEの見え方' })
  expect(within(dialog).getByText('実際の本文')).toBeTruthy()
  expect(check.checked).toBe(false)
  expect(check.disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'B 案の見本' }))
  expect(within(dialog).getByText('B案の本文')).toBeTruthy()
  expect(check.checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'A 案の見本' }))
  expect(check.checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
  fireEvent.click(screen.getByRole('button', { name: '本文を直す' }))
  expect(check.checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '配信イメージを見る' }))
  expect(within(screen.getByRole('dialog', { name: 'LINEの見え方' })).getByText('書き直した本文')).toBeTruthy()
  expect(check.checked).toBe(false)
})

it('狭い幅で見本を開いた時も記録し、本文を変えた後は未確認に戻す', () => {
  render(<ReviewPreview />)
  const check = screen.getByRole('checkbox', { name: 'LINEプレビューが未確認です' }) as HTMLInputElement
  fireEvent.click(screen.getByRole('button', { name: '狭い幅の見本を開く' }))
  expect(check.checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '本文を直す' }))
  expect(check.checked).toBe(false)
})

it('今すぐの見本には時刻を出さず、予約の見本には予約時刻を出す', () => {
  type Props = ComponentProps<typeof BroadcastPreviewRail>
  const props = {
    ab: { hasB: false } as Props['ab'], afterActionVersionId: '', audienceDisplayCount: null,
    bubbles: [{ id: 'a', type: 'text', content: { text: '本文' } }] as Props['bubbles'],
    confirmAudienceLabel: '全員', currentStep: 'confirm' as const, excludeTagId: '', messageButtons: [],
    openTestDialog: vi.fn(async () => {}), preflight: null, preflightStatus: 'idle' as const,
    previewCloseRef: createRef<HTMLButtonElement>(), reviewKey: 'initial', previewConfirmed: false,
    previewOpen: true, previewToggleRef: createRef<HTMLButtonElement>(),
    publishedActions: [], saving: false, scheduledLabel: null, selectedAccount: null,
    sendWhenLabel: '今すぐ（確認してから送信）', setPreviewConfirmed: vi.fn(),
    setPreviewOpen: vi.fn(), tags: [], testBlockReason: '',
  }
  const view = render(<BroadcastPreviewRail {...props} />)
  expect(view.queryByText('10:00')).toBeNull()
  view.rerender(<BroadcastPreviewRail {...props} scheduledLabel="2026/11/04 14:30" />)
  expect(view.getByText('14:30')).toBeTruthy()
})
