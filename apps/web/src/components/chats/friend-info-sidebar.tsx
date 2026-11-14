'use client'
import { asArray } from './friend-detail-shape'

import { STATUS_WORD } from './friend-info-status'

import { type ChatStatusInfo,type Props } from './friend-info-types'

import { PrepayBadgeV8 } from '@/v8/booking/index'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import CustomerInfoMileage from '@/components/shared/customer-info-mileage'
import CustomerInfoPanel, { CustomerInfoViewport } from '@/components/shared/customer-info-panel'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import { DragHandle } from '@/components/shared/row-actions'
import { DelayedSkeleton } from '@/components/shared/skeleton'
import TagOverflow from '@/components/shared/tag-overflow'
import TagPill from '@/components/shared/tag-pill'
import { formatDateTime } from '@/lib/format'
import { canEditFeature,isOwnerOrAdmin } from '@/lib/staff-capability'
import { useStaffRole } from '@/lib/staff-role'
import { usePermissionAccess } from '@/lib/use-feature-access'
import v8 from '@/v8/inbox-chat/customer-panel.module.css'
import { X } from 'lucide-react'
import { Children,isValidElement,useCallback,useEffect,useRef,useState } from 'react'
import { createPortal } from 'react-dom'

import { DEFAULT_SECTION_ORDER,formatAddedDate } from './friend-info-model'
import { createFriendInfoSections } from './friend-info-sections'
import { useFriendInfoData } from './use-friend-info-data'
import { useFriendInfoEditing } from './use-friend-info-editing'
import { useFriendInfoPreferences } from './use-friend-info-preferences'
import { useFriendInfoTags } from './use-friend-info-tags'

export default function FriendInfoSidebar({ friendId, chatStatus, operatorName, chatId, revision, operators, operatorId, accountId, onChatChanged, lastContactAt }: Props) {

  /* 前払いのみの印を外せるのは店の管理者だけ（友だち詳細と同じ決まり）。 */
  const canClearPrepay = usePermissionAccess('administrator')

  // A-2: その場で直したときの画面側の持ち直し（楽観更新）。親の chatDetail とは別に、
  // このパネル内での見た目だけを先に変える。保存が失敗したら戻す。
  const [localStatus, setLocalStatus] = useState<ChatStatusInfo['status'] | undefined>(undefined)

  const [localOperatorId, setLocalOperatorId] = useState<string | null | undefined>(undefined)

  const [localNotes, setLocalNotes] = useState<string | null | undefined>(undefined)

  const [localTags, setLocalTags] = useState<Array<{ id: string; name: string; color: string }> | undefined>(undefined)

  const targetKey = `${accountId ?? ''}:${friendId ?? ''}:${chatId ?? ''}`

  const targetRef = useRef({ key: targetKey, generation: 0 })

  const operationRef = useRef(new Map<string, number>())

  const beginChange = useCallback((scope: string) => {
    const generation = targetRef.current.generation
    const operation = (operationRef.current.get(scope) ?? 0) + 1
    operationRef.current.set(scope, operation)
    return () => targetRef.current.generation === generation && operationRef.current.get(scope) === operation
  }, [])

  useEffect(() => () => { targetRef.current = { ...targetRef.current, generation: targetRef.current.generation + 1 } }, [])

  const effectiveStatus = localStatus !== undefined ? localStatus : chatStatus?.status

  const effectiveOperatorId = localOperatorId !== undefined ? localOperatorId : operatorId

  const effectiveNotes = localNotes !== undefined ? localNotes : chatStatus?.notes

  const [editingSupport, setEditingSupport] = useState(false)

  const [editingMemo, setEditingMemo] = useState(false)

  const [tagToRemove, setTagToRemove] = useState<{ id: string; name: string; friendId: string } | null>(null)

  // 友だち・会話が切り替わったら持ち直しを捨てる。
  useEffect(() => {
    setLocalStatus(undefined)
    setLocalOperatorId(undefined)
    setLocalNotes(undefined)
    setLocalTags(undefined)
    setTagToRemove(null)
    setEditingSupport(false)
    setEditingMemo(false)
  }, [friendId, chatId, accountId])

  /*
   * A-2: 押した瞬間に画面を変えて裏で保存（lib/undoable の runOptimistic）。
   * 成功は白い知らせに「元に戻す」、失敗は戻して「もう一度」。
   * 知らせは notifyToast の白い板（黒にしない。オーナー決定 2026-10-04）。
   */
  const staffRole = useStaffRole()

  const canEditChat = Boolean(chatId) && canEditFeature('/chats', staffRole)

  const canEditFriend = Boolean(friendId) && canEditFeature('/friends', staffRole)

  const statusButtonRef = useRef<HTMLDivElement | null>(null)

  const tagSearchRef = useRef<HTMLInputElement | null>(null)

  const [tagPickerOpen, setTagPickerOpen] = useState(false)

  useEffect(() => { setTagPickerOpen(false) }, [friendId])

  const memoAreaRef = useRef<HTMLTextAreaElement | null>(null)

  /*
   * キーボード T・M・S（書く欄に字があるときは効かない）。
   * T=タグを探す欄へ、M=メモ欄へ、S=対応状況のボタンへ。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 't' && canEditFriend) {
        event.preventDefault()
        {
          setTagPickerOpen(true)
          requestAnimationFrame(() => document.getElementById('inbox-panel-tag')?.focus())
        }
      } else if (key === 'm' && canEditChat) {
        event.preventDefault()
        setEditingMemo(true)
        requestAnimationFrame(() => memoAreaRef.current?.focus())
      } else if (key === 's' && canEditChat) {
        event.preventDefault()
        setEditingSupport(true)
        requestAnimationFrame(() => statusButtonRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canEditFriend, canEditChat])
  const {
    friend,
    setFriend,
    loading,
    error,
    mileage,
    setFriendRetry,
    setMileageRetry,
    setRichMenuRetry,
    setFieldsRetry,
    setUpcomingRetry,
    friendFields,
    richMenu,
    upcoming,
    purchase,
    setPurchaseRetry,
  } = useFriendInfoData({
    friendId,
    accountId,
  })

  const effectiveTags = localTags ?? asArray(friend?.tags)

  /*
   * 友だち情報（metadata）のキーを、画面に出す項目名へ写す対応表。
   * friend_fields.fieldKey → name と、フォームの項目 name → label の
   * 両方を持つ。どちらにも無い内部キー（`_` 始まり）は業務表示から外す。
   */
  const metadataLabel = (key: string): string | null => {
    if (key.startsWith('_')) return null
    const fromField = friendFields.kind === 'data'
      ? friendFields.items.find((field) => field.fieldKey === key)?.name
      : undefined
    if (fromField) return fromField
    const fromForm = asArray(friend?.formSubmissions)
      .flatMap((submission) => asArray(submission.fields))
      .find((field) => field.name === key)?.label
    return fromForm ?? key
  }
  const { showSettings, setShowSettings, draggedGroupKey, setDraggedGroupKey, settingsPanelPos, setSectionOrder, hiddenSections, setHiddenSections, sectionStyle, moveGroup, moveGroupBefore, orderedSettingGroups } = useFriendInfoPreferences()

  const {
    saveChatStatus,
    saveAssignee,
    memoSaving,
    setMemoSaving,
    queueMemoSave,
    saveMetadata,
  } = useFriendInfoEditing({
    setLocalStatus,
    chatStatus,
    setLocalOperatorId,
    operatorId,
    setLocalNotes,
    setLocalTags,
    friend,
    revision,
    chatId,
    targetRef,
    onChatChanged,
    effectiveStatus,
    beginChange,
    effectiveOperatorId,
    operators,
    friendId,
    effectiveNotes,
    setFriend,
    memoAreaRef,
  })
  const {
    tagQuery,
    setTagQuery,
    tagOptions,
    tagActive,
    setTagActive,
    tagSaving,
    addTagById,
    removeTagById,
    tagFolders,
    loadTagFolders,
    createTagForPicker,
    applyTagSelection,
    createAndAddTag,
  } = useFriendInfoTags({
    setMemoSaving,
    targetKey,
    friendId,
    accountId,
    effectiveTags,
    setLocalTags,
    beginChange,
  })
  const {
    renderSupport,
    upcomingRowValue,
    renderTags,
    renderRichMenu,
    stripSectionHeadings,
    sectionBody,
    renderDetailSections,
  } = createFriendInfoSections({
    sectionStyle,
    canEditChat,
    statusButtonRef,
    effectiveStatus,
    saveChatStatus,
    chatStatus,
    operators,
    effectiveOperatorId,
    saveAssignee,
    operatorName,
    memoSaving,
    memoAreaRef,
    chatId,
    effectiveNotes,
    queueMemoSave,
    upcoming,
    setUpcomingRetry,
    friendId,
    canEditFriend,
    tagPickerOpen,
    setTagPickerOpen,
    effectiveTags,
    setTagToRemove,
    tagOptions,
    tagFolders,
    loadTagFolders,
    createTagForPicker,
    tagSaving,
    applyTagSelection,
    tagSearchRef,
    tagQuery,
    setTagQuery,
    setTagActive,
    tagActive,
    addTagById,
    createAndAddTag,
    richMenu,
    setRichMenuRetry,
    accountId,
    canClearPrepay,
    friendFields,
    setFieldsRetry,
    metadataLabel,
    targetKey,
    saveMetadata,
    purchase,
    setPurchaseRetry,
  })

  if (targetRef.current.key !== targetKey) {
    targetRef.current = { key: targetKey, generation: targetRef.current.generation + 1 }
    operationRef.current.clear()
  }

  if (!friendId) return null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      {/*
        ★V8（M0393「その人の要点」）：右の列に「顧客情報 ［表示項目］ ×」の頭の段は無い。
        顔・名前から始まり、「表示項目」は「友だち詳細」の横に並べる（オーナー指摘）。
        v7 は今までどおり頭の段に置く。
      */}
      <div className={'contents'}>
        {null}
        {showSettings && typeof document !== 'undefined' ? createPortal(
          <div
            data-inbox-v6="detail-sections-panel"
            role="dialog"
            aria-label="右パネルの表示項目"
            style={settingsPanelPos ?? { top: 16, left: 16, right: 16, maxHeight: 'calc(100dvh - 32px)' }}
            className="bg-canvas border-hairline rounded-panel shadow-float fixed z-[80] flex flex-col overflow-hidden border"
          >
            <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-4">
              <div className="min-w-0">
                <p className="text-ink text-xs font-medium">右パネルの表示項目</p>
                <p className="text-ink-faint text-micro mt-0.5">ドラッグで順番変更・スイッチで表示切替</p>
              </div>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label="表示項目を閉じる"
                className="text-ink-faint hover:bg-canvas-sunken rounded-control -mt-1 -mr-1 flex h-7 w-7 shrink-0 items-center justify-center"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            {/* 項目の並びはここだけがスクロールする。見出しと操作は常に画面内。 */}
            <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4">
              {orderedSettingGroups.map((group) => {
                const visible = group.sections.every((key) => !hiddenSections.includes(key))
                return (
                  <div
                    key={group.key}
                    draggable
                    onDragStart={(event) => {
                      setDraggedGroupKey(group.key)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDraggedGroupKey(null)}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggedGroupKey) moveGroupBefore(draggedGroupKey, group.key)
                      setDraggedGroupKey(null)
                    }}
                    className="border-hairline rounded-control flex items-center gap-2 border px-2 py-1.5"
                  >
                    <span className="flex shrink-0 items-center">
                      <DragHandle
                        label={`${group.label}を並べ替える`}
                        draggable
                        onDragStart={() => setDraggedGroupKey(group.key)}
                        onDragEnd={() => setDraggedGroupKey(null)}
                        onMove={direction => moveGroup(group.key, direction)}
                      />
                    </span>
                    <span className="text-ink min-w-0 flex-1 truncate text-xs">{group.label}</span>
                    {/* 共通の Checkbox（本物の input）。見た目だけの button にすると読み上げで「入／切」が伝わらない。 */}
                    <Checkbox
                      checked={visible}
                      aria-label={`${group.label}を表示`}
                      onCheckedChange={() => setHiddenSections((current) => (
                        visible
                          ? [...new Set([...current, ...group.sections])]
                          : current.filter((item) => !group.sections.includes(item))
                      ))}
                      className="shrink-0"
                    />
                  </div>
                )
              })}
            </div>
            {/*
              **全部隠すと右パネルが空になり、何を隠したのかも画面から読めない。**
              戻す道をここに置く。スクロール領域の外に固定して、低い画面でも
              「初期状態に戻す」「閉じる」へ届くようにする(#982 LAY-03)。
            */}
            <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border-t border-hairline px-4 py-3">
              {/* 設計 `Xi4x9` の2つは h36。共通ボタンと同値なので部品を使う。 */}
              <Button
                onClick={() => {
                  setSectionOrder(DEFAULT_SECTION_ORDER)
                  setHiddenSections([])
                }}
              >
                初期状態に戻す
              </Button>
              <Button variant="primary" onClick={() => setShowSettings(false)}>
                閉じる
              </Button>
            </div>
          </div>
          , document.body) : null}
      </div>

      <ConfirmDialog
        open={tagToRemove !== null && tagToRemove.friendId === friendId}
        title={`『${tagToRemove?.name ?? ''}』を外しますか？`}
        description="この友だちからタグを外します。タグそのものは消えません。"
        confirmLabel="外す"
        onSuccess={() => setTagToRemove(null)} onCancel={() => setTagToRemove(null)}
        onConfirm={() => {
          if (!tagToRemove || tagToRemove.friendId !== friendId) return
          return removeTagById(tagToRemove.id)
        }}
      />
      <CustomerInfoViewport>
        {loading ? (
          <DelayedSkeleton
            loading
            skeleton={
              <div className="p-4 space-y-3 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-pill bg-shell-gray" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-shell-gray rounded-mini w-32" />
                    <div className="h-2 bg-shell rounded-mini w-20" />
                  </div>
                </div>
              </div>
            }
          />
        ) : error ? (
          /* INBOX-08: 失敗は文字だけにせず、その場で再試行できるようにする。 */
          <div className="space-y-2 p-4">
            <p className="text-xs text-danger">{error}</p>
            <Button variant="secondary" className="text-ink-secondary items-center px-3 py-1.5 text-xs h-auto whitespace-normal" type="button" onClick={() => setFriendRetry((key) => key + 1)}>
              再試行する
            </Button>
          </div>
        ) : friend ? (
          <div className={v8.body}>
            {/* Profile Header — V4は相手・対応・担当をひとまとまりにする。 */}
            {(
              <>
                {/*
                  ★V8（M0393 XqSvX「その人の要点」）：大きい丸の顔 → 名前 → 友だち追加日 →
                  タグ・シナリオ・購入・マイル → 顧客情報の節。顔と要点はいつも上（並べ替えの外）。
                  対応・担当の札は会話の頭にあるので、ここには重ねて出さない。
                */}
                {/*
                  ★V8（M0393 XqSvX「顧客情報」）：節は角丸の枠の中に、見出し＋中身を線で区切って並べる。
                  上の要点（顔・名前・タグ・シナリオ・購入・マイル）とは線で切らず、枠で分ける。
                */}
                {accountId && friendId ? <PrepayBadgeV8 accountId={accountId} friendId={friendId} canEdit={canClearPrepay} /> : null}
                <CustomerInfoPanel
                  labelWidth="wide"
                  friendId={friend.id}
                  profile={{ name: friend.realName || friend.displayName, pictureUrl: friend.pictureUrl, addedAt: formatAddedDate(friend.createdAt) }}
                  fields={friendFields.kind === 'data' ? friendFields.items : []}
                  state={friendFields.kind === 'data' ? 'ready' : friendFields.kind}
                  onRetry={() => setFieldsRetry(key => key + 1)}
                  canEdit={canEditFeature('attribute.personal_info.edit', staffRole)}
                  hiddenPersonalCount={friendFields.kind === 'data' ? friendFields.hiddenPersonalCount : 0}
                  sections={[
                    {
                      key: 'support', label: '対応', action: <PermissionGatedButton allowed={canEditChat} variant="text" size="inline" aria-label="対応を編集" aria-expanded={editingSupport} onClick={() => setEditingSupport(value => !value)}>{editingSupport ? '閉じる' : '編集'}</PermissionGatedButton>, content: <>
                        {editingSupport ? sectionBody(renderSupport(friend)).filter(child => !(isValidElement<{ 'data-customer-memo'?: boolean }>(child) && child.props['data-customer-memo'])) : <>
                          {/* 絵 eovoG：次回予約・次の自動配信も 状況・担当 と同じ行の形（見出し＋値）で続ける。 */}
                          <CustomerInfoRows
                            rows={[{ label: '状況', value: effectiveStatus ? STATUS_WORD[effectiveStatus] : '未設定' }, { label: '担当', value: operators?.find(item => item.id === effectiveOperatorId)?.name ?? operatorName ?? '未割り当て' }, { label: '最後の連絡', value: lastContactAt ? formatDateTime(lastContactAt) : '—' }, { label: '次回予約', value: upcomingRowValue('booking') }, { label: '次の自動配信', value: upcomingRowValue('delivery') }]}
                          />
                          {(upcoming.kind === 'error' || (upcoming.kind === 'data' && (upcoming.data.nextBookingError || upcoming.data.nextAutoDeliveryError))) ? (
                            <Button variant="text" size="inline" onClick={() => setUpcomingRetry((key) => key + 1)}>再試行する</Button>
                          ) : null}
                        </>}
                        {editingSupport ? <CustomerInfoRows rows={[{ label: '最後の連絡', value: lastContactAt ? formatDateTime(lastContactAt) : '—' }]} /> : null}
                      </>
                    },
                    {
                      key: 'tags', label: 'タグ', action: <PermissionGatedButton allowed={canEditFriend} variant="text" size="inline" aria-expanded={tagPickerOpen} aria-controls="inbox-panel-tag-picker" onClick={() => setTagPickerOpen(value => !value)}>{tagPickerOpen ? '閉じる' : '編集'}</PermissionGatedButton>, content: <>
                        <TagOverflow maxVisible={2}>{(effectiveTags ?? []).map(tag => <TagPill
                                                                                        key={tag.id}
                                                                                        name={tag.name}
                                                                                        color={tag.color}
                                                                                        size="xs"
                                                                                        onRemove={canEditFriend && tagPickerOpen && friendId ? () => setTagToRemove({ id: tag.id, name: tag.name, friendId }) : undefined}
                                                                                      />)}</TagOverflow>
                        {(effectiveTags ?? []).length === 0 ? 'なし' : null}
                        {sectionBody(renderTags(friend)).filter(child => isValidElement<{ id?: string }>(child) && child.props.id === 'inbox-panel-tag-picker')}
                      </>
                    },
                    { key: 'mileage', label: 'マイル', action: mileage.kind === 'data' && isOwnerOrAdmin(staffRole) ? <Button href={`/mileage/friends/detail?id=${encodeURIComponent(friend.id)}`} variant="text" size="inline">編集</Button> : null, content: <CustomerInfoMileage state={mileage} onRetry={() => setMileageRetry(key => key + 1)} /> },
                    { key: 'richMenu', label: 'リッチメニュー', action: canEditFeature('/rich-menus', staffRole) ? <Button href="/rich-menus" variant="text" size="inline">編集</Button> : null, content: sectionBody(renderRichMenu()) },
                    { key: 'memo', label: 'メモ', action: <PermissionGatedButton allowed={canEditChat} variant="text" size="inline" aria-label="メモを編集" aria-expanded={editingMemo} onClick={() => setEditingMemo(value => !value)}>{editingMemo ? '閉じる' : '編集'}</PermissionGatedButton>, content: editingMemo ? sectionBody(renderSupport(friend)).filter(child => isValidElement<{ 'data-customer-memo'?: boolean }>(child) && child.props['data-customer-memo']) : effectiveNotes || '未設定' },
                  ]}
                  extraSections={Children.toArray(renderDetailSections(friend).props.children).flatMap(child => {
                    if (!isValidElement<{ 'data-customer-section'?: string; children?: React.ReactNode }>(child)) return []
                    const key = child.props['data-customer-section'] ?? ''
                    const label = ({ starred: '★つき友だち情報', metadata: '友だち情報', forms: 'フォーム回答', purchase: '購入' } as Record<string, string>)[key]
                    return label ? [{ key, label, content: stripSectionHeadings(child.props.children) }] : []
                  })}
                />
              </>
            )}
            {null}
            {/*
              編集導線は将来追加予定 (現在の /friends は ?id= をハンドルしないため、
              リンク先が機能しない → Codex review で指摘済 → 代わりに削除。
              編集 UI が出来たら復活させる)。
            */}
          </div>
        ) : (
          <div className="p-4 text-xs text-ink-faint">友だち情報がありません</div>
        )}
      </CustomerInfoViewport>
    </div>
  )
}
