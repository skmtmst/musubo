// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormOptions } from '@line-crm/shared'
import { AppearanceTab } from './appearance-tab'

function baseProps(overrides: Partial<Parameters<typeof AppearanceTab>[0]> = {}): Parameters<typeof AppearanceTab>[0] {
  return {
    readOnly: false,
    options: {
      totalLimit: { enabled: true, max: 300 },
    } as FormOptions,
    accountId: 'acc-1',
    accountLook: null,
    accountLookError: '',
    portable: false,
    name: 'アンケート',
    nameError: null,
    description: '',
    ogTitle: '',
    ogDescription: '',
    ogImageUrl: '',
    onChangeOptions: vi.fn(),
    onChangeName: vi.fn(),
    onChangeDescription: vi.fn(),
    onChangeOgTitle: vi.fn(),
    onChangeOgDescription: vi.fn(),
    onChangeOgImageUrl: vi.fn(),
    ...overrides,
  }
}

describe('AppearanceTab ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('accountLook 取得失敗時は「今：読み込み中」と誤表示せず「今：確認できません」と出す', () => {
    render(<AppearanceTab {...baseProps({ accountLook: null, accountLookError: '設定を取得できませんでした' })} />)
    expect(screen.getByText('今：確認できません')).toBeTruthy()
    expect(screen.queryByText('今：読み込み中')).toBeNull()
  })

  it('締め切り上限に小数を入力しても整数へ正規化され、不正な保存値でも NaN を出さない', () => {
    const onChangeOptions = vi.fn()
    render(
      <AppearanceTab
        {...baseProps({
          options: { totalLimit: { enabled: true, max: Number.NaN } } as FormOptions,
          onChangeOptions,
        })}
      />,
    )
    expect(screen.getByText('答えの数が —件 になったら締め切る')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()

    const input = screen.getByLabelText('締め切る件数')
    fireEvent.change(input, { target: { value: '12.9' } })
    expect(onChangeOptions).toHaveBeenCalledWith({
      totalLimit: { enabled: true, max: 12 },
    })
  })

  it('readOnly で上限が NaN でも「NaN」を出さず「—」を表示する', () => {
    render(
      <AppearanceTab
        {...baseProps({
          readOnly: true,
          options: { totalLimit: { enabled: true, max: Number.NaN } } as FormOptions,
        })}
      />,
    )
    expect(screen.queryByText('NaN')).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
  })
})
