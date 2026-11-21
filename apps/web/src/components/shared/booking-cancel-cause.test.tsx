// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CancelReservationDialog } from './booking-confirm-dialogs'

afterEach(cleanup)
it('飲食の取消は区分を選ぶまで確定せず、選んだ区分を渡す',()=>{
 const confirm=vi.fn()
 render(<CancelReservationDialog open title="予約を取り消す" subtitle="予約" facts={[]} fullAmount={1000} cancellationOnly requireCause messageFor={()=>''} onClose={()=>{}} onConfirm={confirm} />)
 const dialog=screen.getByRole('alertdialog',{name:'予約を取り消す'})
 fireEvent.change(within(dialog).getByPlaceholderText('お店の都合（食材が届かない）'),{target:{value:'電話で取消'}})
 const button=within(dialog).getByRole('button',{name:'予約を取り消す'}) as HTMLButtonElement
 expect(button.disabled).toBe(true)
 fireEvent.click(within(dialog).getByRole('radio',{name:'お客さまの都合'}))
 fireEvent.click(button)
 expect(confirm).toHaveBeenCalledWith(expect.objectContaining({cause:'customer',reason:'電話で取消'}))
})
