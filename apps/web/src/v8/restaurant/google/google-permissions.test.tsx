import { deferImpersonationSnapshot, forgetSessionSnapshot } from '@/lib/session-snapshot'
import type { OpsImpersonation } from '@/lib/api'
// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { rememberStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'
import { useGooglePermission } from './use-google-permission'
import type { GoogleConnectionData, GoogleProfileData } from '@/lib/restaurant-google-api'
import { PostsBoard, PostEditor, PostConfirm } from './posts'
import { ReviewsBoard } from './reviews'
import ProfileBoard from './profile'
import SettingsBoard from './settings'
import { ChangeConfirmScreen } from './profile-confirm'

const fixture = vi.hoisted(() => ({
  role: 'owner' as string | null,
  handlers: new Map<string, () => unknown>(),
  connection: vi.fn(), posts: vi.fn(), syncPosts: vi.fn(), cancelPost: vi.fn(), removePost: vi.fn(), retryInstagram: vi.fn(),
  post: vi.fn(), publishPost: vi.fn(), createPost: vi.fn(), savePost: vi.fn(),
  listReviews: vi.fn(), syncReviews: vi.fn(), profile: vi.fn(), syncProfile: vi.fn(), proposeHours: vi.fn(),
  connectStart: vi.fn(), selectLocation: vi.fn(), disconnect: vi.fn(), change: vi.fn(), sendChange: vi.fn(), cancelChange: vi.fn(),
}))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: fixture }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'a', name: '対象LINE' }] })) }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
// Keep the actual button's DOM and lock behavior; capture the feature's raw callback to check its own guard too.
vi.mock('@/components/shared/button', async (original) => {
  const actual = await original<typeof import('@/components/shared/button')>()
  const text = (node: React.ReactNode): string => React.Children.toArray(node).map(child => typeof child === 'string' ? child : React.isValidElement<{ children?: React.ReactNode }>(child) ? text(child.props.children) : '').join('')
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.onClick) fixture.handlers.set(text(props.children), props.onClick as () => unknown)
    return <actual.default {...props} />
  } }
})
const connection = (status = 'connected') => ({
  store: { id: 's', name: '合成店', lineAccountId: 'a' }, connection: { id: 'conn', confirmationRevision: 4, status, locationName: 'locations/a', locationTitle: '合成店' },
  candidates: [{ locationName: 'locations/b', locationTitle: '別の合成店' }],
  summary: { storedCount: 1, unrepliedCount: 1, attentionCount: 0, syncStale: true },
  permissions: { canManageConnection: true, canPublishReply: true }, oauthConfigured: true, writeEnabled: true,
}) as unknown as GoogleConnectionData
const profile = {
  profile: { title: '合成店', specialHours: [], regularHours: [], address: null },
  today: { date: '2026-10-30', periods: [{ open: '11:00', close: '20:00' }], closed: false },
  holidays: [], closed: false, googleUpdates: null, photoCount: 0,
} as unknown as GoogleProfileData
const post = { id: 'p', kind: 'standard', status: 'draft', summary: '合成の投稿', title: null, media: [], instagram: null }
function role(next: string | null) {
  fixture.role = verifiedStaffRole(next)
  if (next !== null) rememberStaffIdentity({ ...readStaffIdentity()!, ...(next === 'viewer' ? { role: 'staff' as const, readOnly: true, roleBundle: 'view_only' as const } : {}), permissionViewKeys: ['/restaurant-test/google'] })
}
function locked(name: string, current: string | null) {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement
  if (current === null) {
    expect(button.disabled).toBe(true)
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  } else {
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(PERMISSION_LOCK_REASON.viewer)
  }
  fireEvent.click(button)
  return button
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.handlers.clear(); role('owner')
  fixture.posts.mockResolvedValue({ posts: [post], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
  fixture.listReviews.mockResolvedValue({ reviews: [{ id: 'r', reviewerDisplayName: '合成の投稿者', starRating: 5, comment: '合成', replyStatus: 'unreplied', replyDraft: null }], total: 1, page: 1, perPage: 20 })
  fixture.profile.mockResolvedValue(profile)
  fixture.post.mockResolvedValue({ post, store: { name: '合成店' }, writeEnabled: true, canPublish: true })
  fixture.change.mockResolvedValue({ change: { id: 'c', kind: 'profile', target: { field: 'title' }, before: '前', after: '後', status: 'failed' }, store: { name: '合成店' }, writeEnabled: true, canSend: true })
})
afterEach(() => { cleanup(); forgetSessionSnapshot() })

describe.each(['viewer', null])('Googleの閲覧状態 %s', current => {
  it('投稿の作成は止め、行メニューの読む操作は残す', async () => {
    role(current); const go = vi.fn()
    render(<PostsBoard accountId="a" go={go} />)
    await screen.findByText('合成の投稿')
    locked('投稿を作る', current)
    locked('Googleの状態を確認する', current)
    if (current === null) locked('投稿「合成の投稿」の操作', current)
    else {
      fireEvent.click(screen.getByRole('button', { name: '投稿「合成の投稿」の操作' }))
      const read = await screen.findByRole('menuitem', { name: '中身を見る' })
      expect(read.getAttribute('aria-disabled')).not.toBe('true')
      const edit = screen.getByRole('menuitem', { name: '編集する' })
      expect(edit.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(edit)
      expect(go).not.toHaveBeenCalled()
      fireEvent.click(read)
      expect(go).toHaveBeenCalledExactlyOnceWith({ tab: 'posts', view: 'edit', id: 'p' })
      go.mockClear()
    }
    await act(async () => { await fixture.handlers.get('投稿を作る')?.() })
    expect(go).not.toHaveBeenCalled(); expect(fixture.syncPosts).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('口コミの同期と新しい下書きを灰色にし、自動同期もhandlerも拒否する', async () => {
    role(current); const go = vi.fn()
    render(<ReviewsBoard accountId="a" data={connection()} go={go} onSynced={vi.fn()} />)
    await screen.findByText('合成の投稿者')
    locked('Googleから同期する', current); locked('下書きを作る', current)
    await act(async () => { await fixture.handlers.get('下書きを作る')?.() })
    expect(go).not.toHaveBeenCalled(); expect(fixture.syncReviews).not.toHaveBeenCalled()
  })
  it('プロフィールの変更と同期は灰色、営業時間を読む操作は残す', async () => {
    role(current); const go = vi.fn()
    render(<ProfileBoard accountId="a" go={go} />)
    await screen.findByText('合成店')
    for (const name of ['プロフィールを編集する', '同期する']) locked(name, current)
    await act(async () => {
      await fixture.handlers.get('同期する')?.()
      await fixture.handlers.get('プロフィールを編集する')?.()
    })
    expect(go).not.toHaveBeenCalled(); expect(fixture.proposeHours).not.toHaveBeenCalled(); expect(fixture.syncProfile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '営業時間を開く' })).toHaveProperty('disabled', false)
    expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  })
  it.each(['disconnected', 'pending_location', 'connected'])('設定の %s でもAPIの許可だけでは操作できない', async status => {
    role(current); render(<SettingsBoard accountId="a" data={connection(status)} onChanged={vi.fn()} />)
    const names = status === 'disconnected' ? ['接続する'] : status === 'pending_location' ? ['接続を取り消す', '別のGoogleアカウントでやり直す', 'この店舗を接続する'] : ['接続を解除する', 'つなぎ直す']
    for (const name of names) locked(name, current)
    await act(async () => { for (const name of names) await fixture.handlers.get(name)?.() })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fixture.connectStart).not.toHaveBeenCalled(); expect(fixture.selectLocation).not.toHaveBeenCalled(); expect(fixture.disconnect).not.toHaveBeenCalled()
  })
  it('投稿の作成URLと公開確認URLを直接開いてもAPIとhandlerを止める', async () => {
    role(current); const view = render(<PostEditor accountId="a" postId={null} kind="standard" go={vi.fn()} />)
    locked('下書きを保存する', current); locked('公開内容を確認する', current)
    await act(async () => { await fixture.handlers.get('下書きを保存する')?.(); await fixture.handlers.get('公開内容を確認する')?.() })
    expect(fixture.createPost).not.toHaveBeenCalled(); expect(fixture.savePost).not.toHaveBeenCalled()
    view.unmount(); role(current)
    render(<PostConfirm accountId="a" id="p" go={vi.fn()} />)
    await screen.findByText('この投稿を予約しますか？')
    locked('この内容で予約する', current)
    await act(async () => { await fixture.handlers.get('この内容で予約する')?.() })
    expect(fixture.publishPost).not.toHaveBeenCalled()
  })
  it('プロフィール確認URLを直接開いても送信と取消handlerを止める', async () => {
    role(current); render(<ChangeConfirmScreen accountId="a" ids={['c']} go={vi.fn()} />)
    await screen.findByText('この内容でプロフィールを変更しますか？')
    locked('Googleに変更を送信する', current); locked('キャンセル', current)
    await act(async () => { await fixture.handlers.get('Googleに変更を送信する')?.(); await fixture.handlers.get('キャンセル')?.() })
    expect(fixture.sendChange).not.toHaveBeenCalled(); expect(fixture.cancelChange).not.toHaveBeenCalled()
  })
})
it('オーナーは作成と行操作、設定の確認を開けるが、確認前には解除しない', async () => {
  const go = vi.fn(); const view = render(<PostsBoard accountId="a" go={go} />)
  fireEvent.click(await screen.findByRole('button', { name: '投稿を作る' }))
  expect(go).toHaveBeenCalledWith({ tab: 'posts', view: 'new', kind: 'standard' })
  fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
  expect(await screen.findByRole('menu')).toBeTruthy()
  view.unmount(); role('owner')
  render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '接続を解除する' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain('LINEアカウント')
  await waitFor(() => expect(dialog.textContent).toContain('対象LINE'))
  expect(dialog.textContent).toContain('合成店')
  expect(dialog.textContent).toContain('検証環境')
  expect(fixture.disconnect).not.toHaveBeenCalled()
})
it('接続の確認を開いた後に権限が落ちても、灰色の確認とhandlerで解除を止める', async () => {
  const view = render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '接続を解除する' }))
  await screen.findByRole('alertdialog'); role('viewer')
  view.rerender(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  const buttons = screen.getAllByRole('button', { name: '接続を解除する' })
  expect(buttons.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
  await act(async () => { for (const button of buttons) fireEvent.click(button) })
  expect(fixture.disconnect).not.toHaveBeenCalled()
})
it('Googleの接続先を変える前に元と移行先・LINE・店舗・環境を確認する', async () => {
  render(<SettingsBoard accountId="a" data={connection('pending_location')} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('radio', { name: /別の合成店/ }))
  fireEvent.click(screen.getByRole('button', { name: 'この店舗に切り替える' }))
  const dialog = within(await screen.findByRole('alertdialog'))
  expect(dialog.getByText(/「合成店」から「別の合成店」へ切り替え/)).toBeTruthy()
  expect(await dialog.findByText('対象LINE')).toBeTruthy()
  expect(dialog.getByText('合成店', { exact: true })).toBeTruthy()
  expect(dialog.getByText('検証環境')).toBeTruthy()
  expect(fixture.selectLocation).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: '切り替える' }))
  await waitFor(() => expect(fixture.selectLocation).toHaveBeenCalledWith('a', 'locations/b', true, { expectedConnectionId: 'conn', expectedConfirmationRevision: 4 }))
})
it('接続解除で確認した接続の版を送る', async () => {
  render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '接続を解除する' }))
  const dialog = within(await screen.findByRole('alertdialog'))
  fireEvent.click(dialog.getByRole('button', { name: '接続を解除する' }))
  await waitFor(() => expect(fixture.disconnect).toHaveBeenCalledWith('a', { expectedConnectionId: 'conn', expectedConfirmationRevision: 4 }))
})
it('選択待ちの接続取消でも確認した接続の版を送る', async () => {
  render(<SettingsBoard accountId="a" data={connection('pending_location')} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '接続を取り消す' }))
  const dialog = within(await screen.findByRole('alertdialog'))
  fireEvent.click(dialog.getByRole('button', { name: '取り消す' }))
  await waitFor(() => expect(fixture.disconnect).toHaveBeenCalledWith('a', { expectedConnectionId: 'conn', expectedConfirmationRevision: 4 }))
})
it('店舗を切り替えて戻しても前の接続確認を使えない', async () => {
  const view = render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '接続を解除する' }))
  await screen.findByRole('alertdialog')
  view.rerender(<SettingsBoard accountId="b" data={connection()} onChanged={vi.fn()} />)
  view.rerender(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.disconnect).not.toHaveBeenCalled()
})
it('編集の鍵を持つ担当者だけが機能を変えられ、管理者専用の操作は許可しない', () => {
  role('staff')
  rememberStaffIdentity({ ...readStaffIdentity()!, permissionKeys: ['/restaurant-test/google'] })
  const feature = renderHook(() => useGooglePermission())
  expect(feature.result.current.allowed).toBe(true)
  const manager = renderHook(() => useGooglePermission('manager'))
  expect(manager.result.current.allowed).toBe(false)
  expect(manager.result.current.lockedReason).toBe(PERMISSION_LOCK_REASON.manager)
})

it('オーナーの予約済み投稿でも従来の確認から送信できる', async () => {
  fixture.post.mockResolvedValue({ post: { ...post, status: 'scheduled' }, store: { name: '合成店' }, writeEnabled: true, canPublish: true })
  fixture.publishPost.mockResolvedValue({ post: { ...post, status: 'accepted' }, alreadyPublished: false })
  render(<PostConfirm accountId="a" id="p" go={vi.fn()} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: '公開先・本文・画像・切り取り位置・日時を確認しました' }))
  fireEvent.click(screen.getByRole('button', { name: 'この内容で予約する' }))
  await waitFor(() => expect(fixture.publishPost).toHaveBeenCalledWith('a', 'p'))
})

it('統括以外の管理者はAPIが接続管理を許可しなければ灰色と統括の理由で止める', async () => {
  role('admin')
  const data = connection(); data.permissions.canManageConnection = false
  render(<SettingsBoard accountId="a" data={data} onChanged={vi.fn()} />)
  const button = screen.getByRole('button', { name: 'つなぎ直す' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(PERMISSION_LOCK_REASON.tenantWide)
  await act(async () => { await fixture.handlers.get('つなぎ直す')?.() })
  expect(fixture.connectStart).not.toHaveBeenCalled()
})
it('オーナーでも閲覧の代理ログインへ切り替われば理由とhandlerで止める', async () => {
  render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
  act(() => { deferImpersonationSnapshot({ mode: 'read' } as OpsImpersonation) })
  const button = screen.getByRole('button', { name: 'つなぎ直す' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(PERMISSION_LOCK_REASON.impersonation)
  await act(async () => { await fixture.handlers.get('つなぎ直す')?.() })
  expect(fixture.connectStart).not.toHaveBeenCalled()
})

it('下書きを任されたstaffは公開確認から本文・画像を直せるが、公開はできない', async () => {
  role('staff')
  rememberStaffIdentity({ ...readStaffIdentity()!, permissionKeys: ['/restaurant-test/google'] })
  fixture.post.mockResolvedValue({ post: { ...post, media: [{ mediaId: 'm', filename: '合成画像', sourceUrl: 'data:image/png;base64,' }] }, store: { name: '合成店' }, writeEnabled: true, canPublish: false })
  const go = vi.fn(); render(<PostConfirm accountId="a" id="p" go={go} />)
  await screen.findByText('この投稿を予約しますか？')
  for (const name of ['修正する', '画像を変更', '切り取りを調整']) {
    const button = screen.getByRole('button', { name })
    expect(button.getAttribute('aria-disabled')).not.toBe('true')
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
  }
  expect(go).toHaveBeenCalledTimes(3)
  const publish = screen.getByRole('button', { name: 'この内容で予約する' })
  expect(publish.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(publish.getAttribute('aria-describedby')!)?.textContent).toBe(PERMISSION_LOCK_REASON.manager)
  await act(async () => { await fixture.handlers.get('この内容で予約する')?.() })
  expect(fixture.publishPost).not.toHaveBeenCalled()
})

it('閲覧のみでも送信済み投稿の中身とGoogleの表示先を読める', async () => {
  role('viewer')
  fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published', searchUrl: 'https://example.invalid/google-post' }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
  const go = vi.fn(); render(<PostsBoard accountId="a" go={go} />)
  fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
  const detail = await screen.findByRole('menuitem', { name: '中身を見る' })
  const google = screen.getByRole('menuitem', { name: 'Googleで表示' })
  expect(detail.getAttribute('aria-disabled')).not.toBe('true')
  expect(google.getAttribute('aria-disabled')).not.toBe('true')
  expect(google.getAttribute('href')).toBe('https://example.invalid/google-post')
  expect(google.closest('[data-menu-group]')?.getAttribute('data-menu-group')).toBe('view')
  expect(google.querySelector('.lucide-eye')).toBeTruthy()
  expect(google.querySelector('.lucide-arrow-up-right')).toBeTruthy()
  expect(google.querySelector('.lucide-pencil')).toBeNull()
  const remove = screen.getByRole('menuitem', { name: 'Google から削除' })
  expect(remove.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(remove)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.removePost).not.toHaveBeenCalled()
  fireEvent.click(detail)
  expect(go).toHaveBeenCalledWith({ tab: 'posts', view: 'edit', id: 'p' })
})

it('Google投稿の削除確認に対象アカウントと環境を表示する', async () => {
 fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published', confirmationRevision: 3 }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
 render(<PostsBoard accountId="a" go={vi.fn()} store={{ id: 's', name: '合成店' }} googleLocation="Google 合成店" connection={{ id: 'connection-1', confirmationRevision: 5 }} />)
 fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
 fireEvent.click(await screen.findByRole('menuitem', { name: 'Google から削除' }))
 const dialog = screen.getByRole('alertdialog')
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(within(dialog).getByText('合成店')).toBeTruthy()
 expect(within(dialog).getByText('Google 合成店')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
 fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
 await waitFor(() => expect(fixture.removePost).toHaveBeenCalledWith('a', post.id, { expectedPostRevision: 3, expectedConnectionRevision: 5, expectedConnectionId: 'connection-1' }))
})
it('Google投稿の409後は投稿と接続の版を読み直す', async () => {
 const { ApiError } = await import('@/lib/api')
 fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published', confirmationRevision: 3 }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
 fixture.connection.mockResolvedValue({ ...connection(), connection: { ...connection().connection, id: 'connection-1', confirmationRevision: 6, locationTitle: '新しい店舗' } })
 const onConnectionReloaded = vi.fn()
 render(<PostsBoard accountId="a" go={vi.fn()} store={{ id: 's', name: '合成店' }} googleLocation="Google 合成店" connection={{ id: 'connection-1', confirmationRevision: 5 }} onConnectionReloaded={onConnectionReloaded} />)
 fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
 fireEvent.click(await screen.findByRole('menuitem', { name: 'Google から削除' }))
 const dialog = screen.getByRole('alertdialog')
 fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published', confirmationRevision: 4 }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
 fixture.removePost.mockRejectedValueOnce(new ApiError(409, 'changed'))
 fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
 await within(dialog).findByText('新しい店舗')
 expect(onConnectionReloaded).toHaveBeenCalledWith(expect.objectContaining({ connection: expect.objectContaining({ confirmationRevision: 6 }) }))
 fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度' }))
 await waitFor(() => expect(fixture.removePost).toHaveBeenLastCalledWith('a', post.id, { expectedPostRevision: 4, expectedConnectionRevision: 6, expectedConnectionId: 'connection-1' }))
})
it('Google投稿の古い削除確定はアカウントを切り替えて戻しても送らない', async () => {
 fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published' }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
 const view = render(<PostsBoard accountId="a" go={vi.fn()} />)
 fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
 fireEvent.click(await screen.findByRole('menuitem', { name: 'Google から削除' }))
 const b = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })
 const key = Object.keys(b).find(item => item.startsWith('__reactProps$'))!
 const oldConfirm = (b as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 view.rerender(<PostsBoard accountId="b" go={vi.fn()} />)
 view.rerender(<PostsBoard accountId="a" go={vi.fn()} />)
 await act(async () => { await oldConfirm({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:b, target:b }) })
 expect(fixture.removePost).not.toHaveBeenCalled()
})

it('Google投稿の削除窓を閉じた後の古い確定では送らない', async () => {
 fixture.posts.mockResolvedValue({ posts: [{ ...post, status: 'published' }], total: 1, page: 1, perPage: 20, counts: {}, permissions: { canPublish: true } })
 render(<PostsBoard accountId="a" go={vi.fn()} />)
 fireEvent.click(await screen.findByRole('button', { name: '投稿「合成の投稿」の操作' }))
 fireEvent.click(await screen.findByRole('menuitem', { name: 'Google から削除' }))
 const dialog = within(screen.getByRole('alertdialog'))
 const b = dialog.getByRole('button', { name: '削除する' })
 const key = Object.keys(b).find(item => item.startsWith('__reactProps$'))!
 const held = (b as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
 await act(async () => { await held({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:b, target:b }) })
 expect(fixture.removePost).not.toHaveBeenCalled()
})

it.each(['connected', 'pending_location'])('Google接続 %s の窓を開いた後に接続が変わると古い確認では解除しない', async status => {
 const original = connection(status)
 const view = render(<SettingsBoard accountId="a" data={original} onChanged={vi.fn()} />)
 fireEvent.click(screen.getByRole('button', { name: status === 'connected' ? '接続を解除する' : '接続を取り消す' }))
 const dialog = within(screen.getByRole('alertdialog'))
 const b = dialog.getByRole('button', { name: status === 'connected' ? '接続を解除する' : '取り消す' })
 const key = Object.keys(b).find(item => item.startsWith('__reactProps$'))!
 const held = (b as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 view.rerender(<SettingsBoard accountId="a" data={{...original, connection:{...original.connection, locationName:'locations/other', locationTitle:'別の店'}}} onChanged={vi.fn()} />)
 view.rerender(<SettingsBoard accountId="a" data={original} onChanged={vi.fn()} />)
 await act(async () => { await held({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:b, target:b }) })
 expect(fixture.disconnect).not.toHaveBeenCalled()
})

it('Google接続解除の窓を閉じた後の古い確定では解除しない', async () => {
 render(<SettingsBoard accountId="a" data={connection()} onChanged={vi.fn()} />)
 fireEvent.click(screen.getByRole('button', { name:'接続を解除する' }))
 const dialog = within(screen.getByRole('alertdialog'))
 const b = dialog.getByRole('button', { name:'接続を解除する' })
 const key = Object.keys(b).find(item => item.startsWith('__reactProps$'))!
 const held = (b as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 fireEvent.click(dialog.getByRole('button', { name:'キャンセル' }))
 await act(async () => { await held({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:b, target:b }) })
 expect(fixture.disconnect).not.toHaveBeenCalled()
})
