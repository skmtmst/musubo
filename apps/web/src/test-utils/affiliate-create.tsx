import { act, fireEvent, screen, within } from '@testing-library/react'

/** 現役の作成画面から、実物の友だち選択窓を開く。 */
export async function openAffiliateFriendPicker() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINE の友だちと結びつける' })) })
  const trigger = await screen.findByRole('button', { name: 'LINEの友だちと結びつける' })
  trigger.focus()
  await act(async () => { fireEvent.click(trigger) })
  return { trigger, dialog: await screen.findByRole('dialog') }
}

export async function chooseAffiliateFriend(name: string) {
  const { dialog } = await openAffiliateFriendPicker()
  await act(async () => { fireEvent.click(await within(dialog).findByRole('radio', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })) })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選択する' })) })
}
