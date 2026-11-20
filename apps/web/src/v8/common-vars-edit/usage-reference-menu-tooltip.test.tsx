// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommonVarDeleteImpactItem } from '@line-crm/shared'
import { UsageReferenceMenu } from './usage-reference-menu'

afterEach(cleanup)
const base = { kind: 'broadcast', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b', referenceMode: 'live', referencedVersion: 2 } as CommonVarDeleteImpactItem

describe('固定できない理由', () => {
  it.each([
    ['Google', { pinDisabledReason: 'Google と連携した値は、いつも最新を使います' }, 'Google と連携した値は、いつも最新を使います'],
    ['送信済み', { usage: { ...base, status: '送信済み' } }, '送信済み・完了済みの配信は変更できません'],
    ['権限', { canPin: false }, 'この使用先を編集する権限がありません'],
  ])('%s は hover と focus で理由を示し操作を実行しない', async (_name, changes, reason) => {
    const choose = vi.fn()
    render(<UsageReferenceMenu usage={base} version={2} canPin valueChanged={false} busy={false} onChoose={choose} {...changes} />)
    fireEvent.click(screen.getByRole('button', { name: '案内の操作' }))
    const item = await screen.findByRole('menuitem', { name: '版 2 で固定' })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    fireEvent.blur(item)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    fireEvent.pointerEnter(item, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    fireEvent.pointerLeave(item, { pointerType: 'mouse' })
    fireEvent.blur(item)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    fireEvent.focus(item)
    expect((await screen.findByRole('tooltip')).textContent).toBe(reason)
    fireEvent.click(item)
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(choose).not.toHaveBeenCalled()
  })
  it('保存前の変更は項目内の理由を示して固定を無効にする', async () => {
    const choose = vi.fn()
    render(<UsageReferenceMenu usage={base} version={2} canPin valueChanged busy={false} onChoose={choose} />)
    fireEvent.click(screen.getByRole('button', { name: '案内の操作' }))
    const item = await screen.findByRole('menuitem', { name: /版 2 で固定/ })
    expect(item.hasAttribute('disabled')).toBe(true)
    expect(item.textContent).toContain('変更を保存してから固定してください')
    expect(choose).not.toHaveBeenCalled()
  })

})
