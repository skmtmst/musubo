import { act } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'

async function flush() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

async function type(input: Element, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const WEEK = '日月火水木金土'

/** 日付と時刻を共通の実際の選ぶ窓で確定する。 */
export async function pickDateTime(label: string, iso: string) {
  const [date, time] = iso.split('T')
  const [hour, minute] = time.split(':')
  const [y, mo, d] = date.split('-').map(Number)
  const week = WEEK[new Date(y, mo - 1, d).getDay()]
  fireEvent.click(screen.getByLabelText(label))
  for (let i = 0; i < 24; i += 1) {
    const grid = document.querySelector('[role="grid"]')
    if (grid?.getAttribute('aria-label') === `${y}年${mo}月`) break
    const currentLabel = /^(\d+)年(\d+)月$/.exec(grid?.getAttribute('aria-label') ?? '')
    const current = currentLabel ? Number(currentLabel[1]) * 12 + Number(currentLabel[2]) : y * 12 + mo
    const nav = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === (y * 12 + mo >= current ? '次の月' : '前の月'),
    )!
    fireEvent.click(nav)
  }
  fireEvent.click([...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? '').startsWith(`${y}年${mo}月${d}日（${week}）`),
  )!)
  const reopened = document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
  const timeInput = within(reopened as HTMLElement).getByRole('combobox', { name: '時刻' })
  await type(timeInput, `${hour}:${minute}`)
  fireEvent.blur(timeInput)
  fireEvent.click(within(reopened as HTMLElement).getByRole('button', { name: '確定' }))
  await flush()
}
