// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:'account-a'})}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { staff: { list: async () => ({ success: true, data: [] }) }, media: {contentUrl:()=> 'https://fixture.invalid/photo.png',list:async()=>({success:true,data:{items:[{id:'photo',filename:'人工画像',kind:'image',url:'https://fixture.invalid/photo.png',lineAccountId:'account-a'}],total:1}})} } } ))
import { StaffEditModal } from './staff-edit-dialog'
afterEach(cleanup)
it('保存中は×・キャンセル・Escを止め、失敗後は閉じられる', async () => {
  let reject!: (reason: Error) => void
  const onSave = vi.fn(() => new Promise<void>((_resolve, rejectSave) => { reject = rejectSave }))
  const onClose = vi.fn()
  render(<StaffEditModal staff={{ name: 'staff', display_name: '担当者', is_active: 1 }} onSave={onSave} onClose={onClose} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
  expect(onSave).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => { reject(new Error('保存失敗')) })
  expect(screen.getByText('保存失敗')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('REM3-06 existing staff can choose registered media and save its public URL',async()=>{
 const onSave=vi.fn().mockResolvedValue(undefined)
 render(<StaffEditModal staff={{name:'staff',display_name:'担当者',is_active:1}} onSave={onSave} onClose={()=>{}} />)
 fireEvent.click(screen.getByRole('button',{name:'登録メディアから選択する'}))
 fireEvent.click(await screen.findByRole('option',{name:/人工画像/}))
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 await act(async()=>{})
 expect(onSave).toHaveBeenCalledWith(expect.objectContaining({profile_image_url:'https://fixture.invalid/photo.png'}))
})
