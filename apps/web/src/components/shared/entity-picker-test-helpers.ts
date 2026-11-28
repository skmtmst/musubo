/*
 * 試験用：作ってあるものを選ぶ欄（EntityPickerField・dJZ7Q）から窓を開き、名前の行を選んで確定する。
 * 画面の試験が、前のプルダウン（Select・Combobox）の代わりに使う。本番のコードからは読まない。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect } from 'vitest'

function escape(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 初回描画から body の portal へ移り終わった、現在の窓を返す。 */
export async function findPickerDialog(name?: string) {
  return waitFor(() => {
    const dialog = name ? screen.getByRole('dialog', { name }) : screen.getAllByRole('dialog').at(-1)!
    expect(dialog.closest('[role="presentation"]')?.parentElement).toBe(document.body)
    return dialog
  })
}

/** 1つ選ぶ欄。label は欄の読み上げ名、name は候補の名前。confirm は主ボタンの文字（既定は「選択する」）。dialogName は絞り込みパネルのように窓が2枚あるときに選び口の窓を指名する。 */
export async function pickEntity(label: string, name: string | RegExp, confirm = '選択する', dialogName?: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${escape(label)}(?::|：)?(選択する|変更する)?$`) }))
  const dialog = await findPickerDialog(dialogName)
  await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name }) ?? within(dialog).queryByRole('radio', { name })).not.toBeNull())
  fireEvent.click((within(dialog).queryByRole('checkbox', { name }) ?? within(dialog).getByRole('radio', { name }))!)
  fireEvent.click(within(dialog).getByRole('button', { name: within(dialog).queryByRole('button',{name:confirm}) ? confirm : /^選択する（\d+件）$/ }))
  await waitFor(() => expect(screen.queryAllByRole('dialog').includes(dialog)).toBe(false))
}

/** まとめて選ぶ欄。names の行にチェックを入れて確定する。 */
export async function pickEntities(label: string, names: string[]) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${escape(label)}(?::|：)?(選択する|変更する)?$`) }))
  const dialog = await findPickerDialog()
  for (const name of names) fireEvent.click(await within(dialog).findByRole('checkbox', { name }))
  fireEvent.click(within(dialog).getByRole('button', { name: /^選択する（\d+件）$/ }))
  await waitFor(() => expect(screen.queryAllByRole('dialog').includes(dialog)).toBe(false))
}
