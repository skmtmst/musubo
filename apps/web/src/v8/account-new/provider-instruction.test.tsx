// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Step2Connect from './step2-connect'

afterEach(cleanup)

it('プロバイダーは自動判定したと見せず、利用者に確認を依頼する', () => {
  render(<Step2Connect sub={2} badge="Step 2 / 4" values={{channelId:'',channelSecret:'',providerId:'',loginChannelId:'',loginChannelSecret:''}} fieldErrors={{}} touchedFields={{}} acks={{}} onUpdate={vi.fn()} onTouchField={vi.fn()} onValidateField={vi.fn()} onToggleAck={vi.fn()} onBackTo={vi.fn()} />)
  const instruction = 'Step 1で使ったプロバイダーをLINE Developersで確認してください。'
  expect(screen.getByText(instruction)).toBeTruthy()
  expect(screen.getByLabelText(instruction)).toBeTruthy()
  expect(screen.queryByText('Messaging APIとLINEログインを同じプロバイダーにつなぎます。')).toBeNull()
  expect(screen.getByText('Step 1と同じプロバイダーを選んでください')).toBeTruthy()
})
