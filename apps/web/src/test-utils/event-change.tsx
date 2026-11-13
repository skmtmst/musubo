import { act } from 'react'
import { fireEvent } from '@testing-library/react'

/** 現役の日時欄を操作し、時刻を確定して自動の影響確認を待つ。 */
export async function changeEventStart(time: string) {
  await act(async () => { (document.querySelector('#ev-cr-start') as HTMLButtonElement).click() })
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-labelledby="ev-cr-start-time-label"]')!
  await act(async () => { fireEvent.change(input, { target: { value: time } }) })
  await act(async () => { fireEvent.blur(input) })
  await act(async () => { (Array.from(document.querySelectorAll('[role="dialog"][aria-label="日時を選ぶ"] button')).find((button) => button.textContent?.trim() === '確定') as HTMLButtonElement).click() })
  await waitEventPreview()
}

export async function waitEventPreview() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)) })
}
