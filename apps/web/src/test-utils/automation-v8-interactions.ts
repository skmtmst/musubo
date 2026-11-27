import { act } from 'react'

/** 現役の窓と行の操作を使う。閉じる途中の窓は操作しない。 */
export function automationButton(text: string, scope: ParentNode = document): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text && !node.closest('[data-closing]'))
  if (!button) throw new Error(`ボタンが見つかりません: ${text}`)
  return button
}

export async function clickAutomationButton(text: string, scope: ParentNode = document): Promise<void> {
  await act(async () => { automationButton(text, scope).click() })
}

export async function openFirstAutomationAction(): Promise<void> {
  const menu = document.querySelector<HTMLButtonElement>('[aria-label="1つ目の行うことのその他操作"]')
  if (!menu) throw new Error('先頭の処理の操作がありません')
  await act(async () => { menu.click() })
  await clickAutomationButton('設定を変更する')
}

export async function pickAutomationTag(name: string): Promise<void> {
  if (!document.querySelector('button[id^="v8-tag-"]')) await openFirstAutomationAction()
  await act(async () => { document.querySelector<HTMLButtonElement>('button[id^="v8-tag-"]')!.click() })
  const checkbox = [...document.querySelectorAll<HTMLElement>('[role="checkbox"], input[type="checkbox"]')].find(node => node.getAttribute('aria-label') === name && !node.closest('[data-closing]'))
  if (!checkbox) throw new Error(`タグが見つかりません: ${name}`)
  const checked = checkbox.getAttribute('aria-checked') === 'true' || (checkbox instanceof HTMLInputElement && checkbox.checked)
  if (!checked) await act(async () => { checkbox.click() })
  await clickAutomationButton('選択する（1件）')
}

export async function replaceFirstAutomationAction(label: string): Promise<void> {
  const menu = document.querySelector<HTMLButtonElement>('[aria-label="1つ目の行うことのその他操作"]')
  if (!menu) throw new Error('先頭の処理の操作がありません')
  await act(async () => { menu.click() })
  await clickAutomationButton('削除する')
  await clickAutomationButton('削除する')
  await clickAutomationButton('行うことを足す')
  await clickAutomationButton(label)
}

export async function pickAutomationTestFriend(id: string): Promise<void> {
  await act(async () => { document.querySelector<HTMLButtonElement>('#v8-test-friend')!.click() })
  // 友だちの窓は250ms後に読む。画面と同じ検索を待ってから確定する。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  const candidate = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.value === id && !input.closest('[data-closing]'))
  if (!candidate) throw new Error(`友だちが見つかりません: ${id}`)
  await act(async () => { candidate.click() })
  await clickAutomationButton('選択する')
}
