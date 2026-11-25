'use client'

import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SUPPORT_STATUS_LABELS } from '@/components/shared/status-pill'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Checkbox from '@/components/shared/checkbox'

import Select from '@/components/shared/select'
import Notice from '@/components/shared/notice'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import Button from '@/components/shared/button'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import CloseButton from '@/components/shared/close-button'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/**
 * 受信箱の「この条件を保存」（設計 Pencil `Ln4zS` 保存した検索名入力モーダル）。
 *
 * 前は保存した検索のパネルの中に、名前の入力欄と保存ボタンが**直接**
 * 並んでいました。**何を保存しようとしているのかが書いていない**ので、
 * 絞り込みを変えたつもりで前の条件を保存してしまいます。設計は名前と
 * 「保存する条件」を並べて見せてから保存させます。
 *
 * 名前の上限は40文字。**残りではなく「11 / 40文字」と出す。**
 * 残り字数だけだと、上限が何文字なのかが分かりません。
 */

const NAME_LIMIT = 40

export type SavedViewSaveResult =
  | { success: true }
  | { success: false; error: string }

export type SavedViewDraft = {
  name: string
  status: 'all' | 'unread' | 'in_progress' | 'on_hold' | 'resolved'
  /** 一覧上部の「すべて／要返信／1時間以上待ち」。N-020 で期限の2値から3値へ。 */
  quickFilter: 'all' | 'reply' | 'overdue'
  channel: 'all' | 'line' | 'email'
  assignee: string
  /** 絞り込みパネルの「未読だけ表示」。 */
  unreadOnly: boolean
  favorite: boolean
}

export default function SavedViewDialog({
  open,
  initialValue,
  operators,
  existingNames,
  saving,
  emailInboxEnabled = true,
  onSave,
  onClose,
}: {
  open: boolean
  initialValue: Omit<SavedViewDraft, 'name'>
  operators: Array<{ id: string; name: string }>
  /** 同じ名前があるかを見るための一覧 */
  existingNames: string[]
  saving: boolean
  emailInboxEnabled?: boolean
  /** 保存先が成功を返したときだけ、完了画面へ進める。 */
  onSave: (draft: SavedViewDraft) => Promise<SavedViewSaveResult>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  /*
   * INBOX-22: 開いた直後の未入力はエラーではなく「まだ何もしていない
   * 通常の状態」。入力してから消したときだけ、必須の断りを赤くする。
   * 保存ボタンは空のあいだ押せないので、押せない理由はボタン側の
   * title と中立の案内で伝える。
   */
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [status, setStatus] = useState(initialValue.status)
  const [quickFilter, setQuickFilter] = useState(initialValue.quickFilter)
  const [channel, setChannel] = useState(initialValue.channel)
  const [assignee, setAssignee] = useState(initialValue.assignee)
  const [unreadOnly, setUnreadOnly] = useState(initialValue.unreadOnly)
  const [favorite, setFavorite] = useState(initialValue.favorite)

  useEffect(() => {
    if (!open) return
    setName('')
    setNameTouched(false)
    setError('')
    setDone(false)
    setStatus(initialValue.status)
    setQuickFilter(initialValue.quickFilter)
    setChannel(initialValue.channel)
    setAssignee(initialValue.assignee)
    setUnreadOnly(initialValue.unreadOnly)
    setFavorite(initialValue.favorite)
  }, [open, initialValue.status, initialValue.quickFilter, initialValue.channel, initialValue.assignee, initialValue.unreadOnly, initialValue.favorite])

  /*
   * INBOX-02追補: 共通のオーバーレイ約束。開いたら窓の中へフォーカス、
   * Tab は窓の中で回し、Escape で閉じ、閉じたら起点のボタンへ戻す。
   * 保存中は Escape で閉じない（応答待ちの結果を宙に浮かせない）。
   */
  const dialogRef = useOverlayFocus(open, onClose, saving)

  if (!open || typeof document === 'undefined') return null

  /*
    **名前が空のあいだは、最初から押せない。**

    前は空のまま押せて、押してはじめて「検索名を入力してください」と赤字が
    出た。**押せる形で置いてあるものは、押せば進むと読む。** 押してから
    断るのではなく、何をすれば進めるかを先に書く。
  */
  const nameMissing = name.trim() === ''
  /* INBOX-22: 開いた直後の未入力は中立。入力→削除したあとだけ赤い断りにする。 */
  const showMissingError = nameMissing && nameTouched
  const nameInvalid = Boolean(error) || showMissingError

  const submit = async () => {
    const trimmed = name.trim()
    /*
      **空と重複を、別の文だけで言い分ける。** 「保存できません」だけだと、
      名前を書けばいいのか、別の名前にすればいいのかが分からない。
    */
    if (!trimmed) {
      setError('検索名を入力してください')
      return
    }
    if (existingNames.some((existing) => existing.trim() === trimmed)) {
      setError('同じ名前の保存した検索があります。別の名前を入力してください。')
      return
    }
    setError('')
    const result = await onSave({ name: trimmed, status, quickFilter, channel: emailInboxEnabled ? channel : 'line', assignee, unreadOnly, favorite })
    if (!result.success) {
      setError(result.error)
      return
    }
    setDone(true)
  }

  return createPortal(
    <div
      className="bg-ink/35 fixed inset-0 z-[110] flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="保存した検索を作成"
        data-qa-dialog="saved-view"
        /*
          INBOX-11: 高さは画面の上下16pxを差し引いた範囲。見出しと
          フッターは固定し、条件の本文だけをスクロールさせる。
          1920×600でもタイトル・取消・保存へ届く。
        */
        className="bg-canvas rounded-panel flex max-h-[calc(100dvh-2rem)] w-[560px] max-w-full flex-col overflow-hidden shadow-overlay"
      >
        <header className="border-hairline flex items-start gap-4 border-b px-6 py-5">
          <div>
            <h2 className="text-ink text-base font-bold">保存した検索を作成</h2>
            <p className="text-ink-secondary mt-1 text-xs">検索名と絞り込み条件を変更して保存できます</p>
          </div>
          <CloseButton onClick={onClose} className="ml-auto" />
        </header>

        {done ? (
          <div className="px-6 py-8">
            <p className="text-accent-deep text-sm font-bold">保存しました</p>
            <p className="text-ink-secondary mt-1.5 text-xs">
              「保存した検索」から、いつでもこの条件を呼び出せます。
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div>
              <div className="flex items-baseline justify-between">
                <label htmlFor="saved-view-name" className="text-ink-secondary text-xs font-medium">
                  検索名 <span className="text-ink-faint font-medium">（必須）</span>
                </label>
                {/* 残りではなく「11 / 40文字」。上限が何文字かが分かる。 */}
                <span className="text-ink-faint text-micro tabular-nums">{name.length} / {NAME_LIMIT}文字</span>
              </div>
              <SaveErrorField names={["name"]}><SharedTextField
                id="saved-view-name"
                value={name}
                onChange={(event) => { setName(event.target.value); setNameTouched(true); setError('') }}
                maxLength={NAME_LIMIT}
                placeholder="検索名を入力してください"
                /*
                  INBOX-22: 開いた直後の未入力は赤くしない。まだ何も
                  していない状態と、入力を消した状態・失敗を分ける。
                  赤い断りは「入力してから消した」「保存に失敗した」
                  ときだけにする。
                */
                aria-invalid={nameInvalid}
                aria-describedby={error ? 'saved-view-error' : nameMissing ? 'saved-view-name-hint' : undefined}
                className={`rounded-control text-ink mt-1.5 h-11 w-full border px-3 text-sm outline-none ${nameInvalid ? 'border-danger' : 'border-hairline'}`}
              /></SaveErrorField>
            </div>

            <div>
              <p className="text-ink-secondary text-xs font-medium">保存する条件</p>
              <dl className="border-hairline rounded-control mt-1.5 divide-y divide-[color:var(--color-hairline)] border">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <dt className="text-ink-secondary text-xs">対応状況</dt>
                  <dd>
                    <Select
                      aria-label="保存する対応状況"
                      value={status}
                      onChange={(value) => setStatus(value as SavedViewDraft['status'])}
                      options={[
                        { value: 'all', label: 'すべて' },
                        { value: 'unread', label: SUPPORT_STATUS_LABELS.unread },
                        { value: 'in_progress', label: SUPPORT_STATUS_LABELS.in_progress },
                        { value: 'on_hold', label: SUPPORT_STATUS_LABELS.on_hold },
                        { value: 'resolved', label: SUPPORT_STATUS_LABELS.resolved },
                      ]}
                      className="h-9 w-40 text-xs font-medium"
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <dt className="text-ink-secondary text-xs">絞り込み</dt>
                  <dd>
                    <Select
                      aria-label="保存する絞り込み"
                      value={quickFilter}
                      onChange={(value) => setQuickFilter(value as SavedViewDraft['quickFilter'])}
                      options={[
                        { value: 'all', label: 'すべて' },
                        { value: 'reply', label: '要返信' },
                        // INBOX-10: 対応期限ではなく「未対応のまま1時間」を数える。
                        { value: 'overdue', label: '1時間以上待ち' },
                      ]}
                      className="h-9 w-40 text-xs font-medium"
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <dt className="text-ink-secondary text-xs">未読</dt>
                  <dd>
                    <Select
                      aria-label="保存する未読条件"
                      value={unreadOnly ? 'unread' : 'all'}
                      onChange={(value) => setUnreadOnly(value === 'unread')}
                      options={[
                        { value: 'all', label: 'すべて' },
                        { value: 'unread', label: '未読だけ' },
                      ]}
                      className="h-9 w-40 text-xs font-medium"
                    />
                  </dd>
                </div>
                {emailInboxEnabled && <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <dt className="text-ink-secondary text-xs">受信経路</dt>
                  <dd>
                    <Select
                      aria-label="保存する受信経路"
                      value={channel}
                      onChange={(value) => setChannel(value as SavedViewDraft['channel'])}
                      options={[
                        { value: 'all', label: 'LINE・MAIL' },
                        { value: 'line', label: 'LINE' },
                        { value: 'email', label: 'MAIL' },
                      ]}
                      className="h-9 w-40 text-xs font-medium"
                    />
                  </dd>
                </div>}
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <dt className="text-ink-secondary text-xs">担当</dt>
                  <dd className="w-40">
                    <EntitySelect clearable size="full"
                      aria-label="保存する担当者"
                      placeholder="すべて"
                      value={assignee === 'all' ? '' : assignee}
                      onChange={(next) => setAssignee(next || 'all')}
                      options={[
                        { value: 'unassigned', label: '未割り当て' },
                        ...operators.map((operator) => ({ ...entityOptionMetadata(operator), value: operator.id, label: operator.name })),
                      ]}
                      className="w-full"
                    />
                  </dd>
                </div>
              </dl>
            </div>

            <Checkbox
              checked={favorite}
              onCheckedChange={setFavorite}
              aria-label="よく使うに追加"
              description="保存した検索一覧の上部に表示します"
            >よく使うに追加</Checkbox>

            {/* 設計 `AuSDY` と同じく、直す場所を見たあとに理由を読む。 */}
            {error || showMissingError ? (
              <Notice
                id={error ? 'saved-view-error' : 'saved-view-name-hint'}
                tone="danger"
                message={error || '検索名を入力してください。'}
              />
            ) : nameMissing ? (
              /*
                INBOX-22: まだ何も入力していない初期状態は、赤いエラーではなく
                中立色の案内。必須であることと、押せない理由をここで伝える。
              */
              <Notice
                id="saved-view-name-hint"
                tone="warn"
                message="検索名は必須です。入力すると保存できるようになります。"
              />
            ) : (
              <Notice
                tone="warn"
                message="保存されるのは検索条件です。受信件数は最新の状態に自動更新されます。"
              />
            )}
          </div>
        )}

        {/*
          INBOX-11: 短い操作名は途中で改行させない。狭い幅では
          2つの操作を縦に積み、どちらも全幅で読めるようにする。
        */}
        <footer className="border-hairline flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-6 py-4">
          {done ? (
            <Button variant="primary" className="whitespace-nowrap px-5 py-2 font-bold border-0 h-auto" type="button" onClick={onClose}>
              閉じる
            </Button>
          ) : (
            <>
              <Button variant="secondary" className="text-ink-secondary whitespace-nowrap px-4 py-2 h-auto" type="button" onClick={onClose}>
                キャンセル
              </Button>
              <Button variant="primary" className="whitespace-nowrap px-5 py-2 font-bold border-0 h-auto" type="button" onClick={() => submit()} disabled={saving || nameMissing} title={nameMissing ? '検索名を入力してください' : undefined}  busy={saving} busyLabel="保存中" widthReserve="idle">
                {'検索条件を保存する'}
              </Button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  )
}
