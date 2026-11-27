// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import LedgerEmpty from './ledger-empty'

const role = vi.hoisted(()=>({value:'owner' as string | null}))
vi.mock('@/lib/staff-role',()=>({useStaffIdentity:()=>({id:'staff-1'}),useStaffRole:()=>role.value,canManageRole:(value:string|null)=>value==='owner'||value==='admin'}))
beforeEach(()=>{role.value=verifiedStaffRole('owner');forgetSessionSnapshot()})
afterEach(()=>{cleanup();verifiedStaffRole(null);forgetSessionSnapshot()})

it.each([true,false])('店主でも閲覧の代理ログイン中は空表示からの変更を止める（卓なし：%s）', async noTables => {
  const onCreate=vi.fn()
  render(<LedgerEmpty noTables={noTables} canWrite busy={false} onCreate={onCreate}/>)
  act(()=>rememberSessionSnapshot({impersonation:{id:'proxy',tenantId:'tenant',mode:'read',piiRevealed:false,startedAt:''},unfamiliarAt:null,stepUpMethod:'none'}))
  const action=screen.getByRole('button',{name:noTables?'座席・卓を設定する':'電話の予約を入れる'})
  expect(action.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(action)
  expect((await screen.findByRole('tooltip')).textContent).toBe(PERMISSION_LOCK_REASON.impersonation)
  fireEvent.click(action)
  expect(onCreate).not.toHaveBeenCalled()
  expect(screen.queryByRole('link',{name:'座席・卓を設定する'})).toBeNull()
})

it('本人の役割が読めるまでは理由なしの無効な設定操作を置く',()=>{
  role.value=verifiedStaffRole(null)
  render(<LedgerEmpty noTables canWrite={false} busy={false} onCreate={()=>{}}/>)
  expect(screen.getByRole('button',{name:'座席・卓を設定する'}).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('tooltip')).toBeNull()
})


it.each([true, false])('予約がない時は条件によって空の案内と作成操作を分ける（絞り込み：%s）', filtered => {
  const onCreate = vi.fn()
  render(<LedgerEmpty noTables={false} filtered={filtered} canWrite busy={false} onCreate={onCreate} />)
  expect(screen.getByText(filtered ? '条件に合う予約はありません' : '予約はまだありません')).toBeTruthy()
  expect(screen.queryByText(filtered ? '予約はまだありません' : '条件に合う予約はありません')).toBeNull()
  const create = screen.queryByRole('button', { name: '電話の予約を入れる' })
  if (filtered) {
    expect(create).toBeNull()
    expect(screen.getByText('期間や状態、予約元の条件を変えて確認してください。')).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()
  } else {
    expect(create).toBeTruthy()
    fireEvent.click(create!)
    expect(onCreate).toHaveBeenCalledTimes(1)
  }
})
