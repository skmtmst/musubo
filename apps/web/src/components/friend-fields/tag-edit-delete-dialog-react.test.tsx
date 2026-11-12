// @vitest-environment happy-dom
/*
 * タグ編集の削除の窓（DeleteDialog）を描いて押す。
 * 参照件数は読んだ実値の合計・取れていない間は「—」で押せず理由を出す・名前を打つまで押せない。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'
import type { TagDeleteImpactReferences, TagDependencies } from '@/lib/api'
import { DeleteDialog } from './edit-tag-page-v4'

const captured = vi.hoisted(() => ({ deleteClick: undefined as undefined | (() => void) }))
vi.mock('@/components/shared/button', async original => {
  const actual = await original<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (React.Children.toArray(props.children).some(child => typeof child === 'string' && child.includes('タグを削除する'))) captured.deleteClick = props.onClick as () => void
    return <actual.default {...props} />
  } }
})

const tag = { id: 't1', name: '通常タグ', friendCount: 1 } as Tag
const refs = {
  broadcasts: 2, forms: 0, templates: 0, richMenus: 0, webinars: 0, events: 0, bookingMenus: 0, entryRoutes: 0, trackedLinks: 0,
  affiliateOffers: 1, analyticsFunnels: 0, scenarios: 4, autoReplies: 0, savedSearches: 1, automations: 0, commonActions: 0, reminders: 0, friendAddSettings: 0,
} as TagDeleteImpactReferences
const dependencies = { friendCount: 9, referenceCounts: refs } as TagDependencies
const row = (term: string) => [...document.querySelectorAll('dl > div')].find((item) => item.querySelector('dt')?.textContent === term)?.querySelector('dd')?.textContent
const deleteButton = () => screen.getByRole('button', { name: 'タグを削除する' }) as HTMLButtonElement
const confirmInput = () => screen.getByLabelText(/確認のため「通常タグ」と入力してください/) as HTMLInputElement

afterEach(cleanup)

describe('タグ編集の削除の窓', () => {
  it('閉じた窓の削除は再度開いた窓へ持ち越さない', () => {
    const onDelete = vi.fn(), onCancel = vi.fn()
    const first = render(<DeleteDialog tag={tag} dependencies={dependencies} dependenciesStatus="ready" deleting={false} initialConfirmation="通常タグ" onCancel={onCancel} onDelete={onDelete} />)
    const oldClick = captured.deleteClick!
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    oldClick()
    expect(onDelete).not.toHaveBeenCalled()
    first.unmount()
    render(<DeleteDialog tag={tag} dependencies={dependencies} dependenciesStatus="ready" deleting={false} onCancel={onCancel} onDelete={onDelete} />)
    oldClick()
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.change(confirmInput(), { target: { value: '通常タグ' } })
    fireEvent.click(deleteButton())
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['loading', '影響を確認しています'],
    ['error', '影響を確認できませんでした。開き直してください'],
  ] as const)('影響が%sの間は件数を「—」にし、名前の欄も削除も押せず理由を出す', (status, reason) => {
    render(<DeleteDialog tag={tag} dependencies={null} dependenciesStatus={status} deleting={false} onCancel={() => {}} onDelete={() => {}} />)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(row('配信・シナリオなどの参照')).toBe('—')
    expect(row('自動付与の参照')).toBe('—')
    expect(confirmInput().disabled).toBe(true)
    expect(deleteButton().disabled).toBe(true)
  })

  it('読めたら人が選ぶ参照と自動の参照を実値で合計し、名前を打つと削除できる', () => {
    const onDelete = vi.fn()
    render(<DeleteDialog tag={tag} dependencies={dependencies} dependenciesStatus="ready" deleting={false} onCancel={() => {}} onDelete={onDelete} />)
    expect(row('タグが付いている友だち')).toBe('9人')
    expect(row('配信・シナリオなどの参照')).toBe('3件')
    expect(row('自動付与の参照')).toBe('5件')
    expect(deleteButton().disabled).toBe(true)
    fireEvent.change(confirmInput(), { target: { value: '通常タグ' } })
    expect(deleteButton().disabled).toBe(false)
    fireEvent.click(deleteButton())
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
