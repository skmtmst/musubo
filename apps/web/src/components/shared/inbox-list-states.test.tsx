import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InboxListEmpty, InboxListFailure, inboxFailureText } from './inbox-list-states'

describe('受信箱の空と失敗はほかの一覧と同じ形', () => {
  it('空は印・題・説明。絞り込み中だけ外す操作を出す', () => {
    const empty = renderToStaticMarkup(<InboxListEmpty filtered={false} onClear={() => {}} />)
    expect(empty).toContain('data-inbox-list-state="empty"')
    expect(empty).toContain('まだ会話がありません')
    expect(empty).toContain('LINE で話しかけられるとここに出ます。')
    expect(empty).not.toContain('<button')
    const filtered = renderToStaticMarkup(<InboxListEmpty filtered onClear={() => {}} />)
    expect(filtered).toContain('data-inbox-list-state="filtered-empty"')
    expect(filtered).toContain('絞り込みを外す')
  })

  it('未設定の Instagram・メールはそれぞれの空案内とマークを出す', () => {
    const ig = renderToStaticMarkup(<InboxListEmpty filtered={false} channel="instagram" unconfigured onClear={() => {}} />)
    expect(ig).toContain('data-brand-mark="instagram"')
    expect(ig).toContain('Instagram はまだつながっていません')
    expect(ig).toContain('Instagram をつなぐと、DM がここに届きます。')

    const mail = renderToStaticMarkup(<InboxListEmpty filtered={false} channel="email" unconfigured onClear={() => {}} />)
    expect(mail).toContain('メールはまだ設定されていません')
    expect(mail).toContain('メールを設定すると、問い合わせメールがここに届きます。')
  })

  it('会話とメールが両方失敗しても、知らせと「もう一度読み込む」は1つ', () => {
    const html = renderToStaticMarkup(<InboxListFailure failed={['line', 'email']} shown={['line', 'email']} onRetry={() => {}} />)
    expect(html.match(/role="alert"/g)?.length).toBe(1)
    expect(html.match(/もう一度読み込む/g)?.length).toBe(1)
    expect(html).not.toContain('text-danger underline')
    expect(renderToStaticMarkup(<InboxListFailure failed={[]} shown={['line']} onRetry={() => {}} />)).toBe('')
  })

  it('何が読めて何が読めないかを書き、読めない方の件数は分からないと言う', () => {
    expect(inboxFailureText(['email'], ['line', 'email'])).toBe('メールを読み込めませんでした。読み込めていないため件数は分かりません。LINE の会話は読めています。')
    expect(inboxFailureText(['line', 'email'], ['line', 'email'])).toBe('LINE の会話とメールを読み込めませんでした。読み込めていないため件数は分かりません。')
    expect(inboxFailureText(['line'], ['line'])).toBe('LINE の会話を読み込めませんでした。読み込めていないため件数は分かりません。')
  })
})
