'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, describeSaveFailure, type TagDependencies, type TagDeleteImpactReferences } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { CreatePage } from '@/components/templates/create-page'
import { Field, TextInput } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { notifyToast } from '@/components/shared/toast'
import { formatNumber } from '@/lib/format'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/**
 * 一覧の `DeleteTagDialog` (`tags-page-v4.tsx`) と同じ分け方。
 *
 * - 配信・シナリオなどの参照 … 人が選んで使っているもの(11種)
 * - 自動付与の参照 … ひとりでに動くもの(7種)
 */
const MANUAL_REF_KEYS: Array<keyof TagDeleteImpactReferences> = [
  'broadcasts', 'forms', 'templates', 'richMenus', 'webinars', 'events',
  'bookingMenus', 'entryRoutes', 'trackedLinks', 'affiliateOffers', 'analyticsFunnels',
]
const AUTO_REF_KEYS: Array<keyof TagDeleteImpactReferences> = [
  'scenarios', 'autoReplies', 'savedSearches', 'automations',
  'commonActions', 'reminders', 'friendAddSettings',
]

function sumRefCounts(counts: TagDeleteImpactReferences, keys: Array<keyof TagDeleteImpactReferences>): number {
  return keys.reduce((total, key) => total + (counts[key] ?? 0), 0)
}

export function DeleteDialog({ tag, accountId, dependencies, dependenciesStatus, onCancel, onDelete, deleting, initialConfirmation = '' }: { tag: Tag; accountId?: string | null; dependencies: TagDependencies | null; dependenciesStatus: 'loading' | 'ready' | 'error'; onCancel: () => void; onDelete: () => void; deleting: boolean; initialConfirmation?: string }) {
  const [confirmation, setConfirmation] = useState(initialConfirmation)
  const confirmationId = useId()
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const close = () => { if (active.current && !deleting) { active.current = false; onCancel() } }
  const remove = () => { if (active.current) onDelete() }
  /*
   * 参照件数は `load` で取った実値を出す。取れていないときは `—`。
   * 0件と書くと「消しても大丈夫」と読み違える。**取れていないあいだは
   * 削除を押せなくする。** 失敗を「参照0件」と読み違えて使用中の
   * タグを消させないため(一覧の `DeleteTagDialog` と同じ作法)。
   */
  const manualRefs = dependencies ? sumRefCounts(dependencies.referenceCounts, MANUAL_REF_KEYS) : null
  const autoRefs = dependencies ? sumRefCounts(dependencies.referenceCounts, AUTO_REF_KEYS) : null
  const blocked = dependenciesStatus !== 'ready' || !dependencies
  const blockedReason = dependenciesStatus === 'loading'
    ? '影響を確認しています'
    : dependenciesStatus === 'error'
      ? '影響を確認できませんでした。開き直してください'
      : ''
  /*
   * R138: 手作りの確認窓を共通の `Dialog` へ統一した。以前は開いても
   * フォーカスが背後に残り、Shift+Tab で背後の保存へ抜け、Escape で
   * 閉じず、見出しとの紐付けも無かった。共通窓が開始時のフォーカス・
   * 窓内の Tab 循環・Escape・終了後の復帰・見出しの紐付けを持つ。
   * 入力確認（名前の typing）が必要なため、操作欄だけ `footer` で渡す。
   */
  return (
    <Dialog
      open
      tone="destructive"
      title={`「${tag.name}」を削除しますか？`}
      description="削除すると、このタグを使っている設定と友だちへの付与状態に影響します。"
      busy={deleting}
      onCancel={close}
      footer={(<DialogActions leadingAction={blockedReason || undefined}>
          <Button onClick={close} disabled={deleting}>キャンセル</Button>
          <Button
            variant="danger"
            onClick={remove}
            disabled={deleting || blocked || confirmation !== tag.name} busy={deleting} busyLabel="削除中…">タグを削除する
          </Button>
        </DialogActions>)}
    >
      <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
      <div className="w-full overflow-hidden rounded-control border border-hairline">
        <dl className="divide-y divide-hairline text-sm">
          <div className="flex justify-between px-4 py-3"><dt className="text-ink-secondary">タグが付いている友だち</dt><dd className="font-medium">{formatNumber((dependencies?.friendCount ?? tag.friendCount ?? 0))}人</dd></div>
          <div className="flex justify-between px-4 py-3"><dt className="text-ink-secondary">配信・シナリオなどの参照</dt><dd className="font-medium">{manualRefs === null ? '—' : `${manualRefs}件`}</dd></div>
          <div className="flex justify-between px-4 py-3"><dt className="text-ink-secondary">自動付与の参照</dt><dd className="font-medium">{autoRefs === null ? '—' : `${autoRefs}件`}</dd></div>
          <div className="flex justify-between px-4 py-3"><dt className="text-ink-secondary">連動アクション</dt><dd className="font-medium">停止</dd></div>
          <div className="flex justify-between px-4 py-3"><dt className="text-ink-secondary">すでに積んだマイル</dt><dd className="font-medium">そのまま残る</dd></div>
        </dl>
      </div>
      <Notice tone="warn" role="alert" className="mt-4">アフィリエイトや外部連携で使用中の場合は削除できません。削除後は元に戻せません。</Notice>
      <div className="mt-5"><Field label={`確認のため「${tag.name}」と入力してください`} htmlFor={confirmationId} required><SaveErrorField names={["confirmation"]}><TextInput id={confirmationId} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={blocked || deleting} /></SaveErrorField></Field></div>
    </Dialog>
  )
}

/**
 * 保管済み(archived)タグの専用画面（Issue #710）。
 *
 * `TagEditorV4`（フォルダ・スター・マイル・連動アクションまで持つ通常の
 * 編集フォーム）は使わない。archived タグはサーバ側
 * （`updateTagDefinition`）が名前・説明以外の変更を拒否するため、それ以外
 * の項目を編集できるように見せても保存できず、利用者が混乱する。
 *
 * タグには archived を active に戻す口が無い（司令塔裁定・Issue #710）。
 * 戻せないので、名前・説明の訂正だけは常に許す。
 */
export function ArchivedTagEditor({ tag, accountId, onCancel, onSaved }: {
  tag: Tag
  accountId: string
  onCancel: () => void
  onSaved: (updated: Tag) => void
}) {
  const saveErrors = useSaveFormErrors()

  const [name, setName] = useState(tag.name)
  const [description, setDescription] = useState(tag.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // M956: 応答消失後の再送用。同じ内容の再送は同じ要求キー、成功したら捨てる。
  const saveKeysRef = useRef(new IdempotencyKeyStore())

  const save = async () => {

    setSaving(true)
    setError('')
    try {
      const payload = { name, description: description || null }
      const sig = JSON.stringify(payload)
      const result = await api.tags.updateArchivedNameAndDescription(tag.id, accountId, tag.version ?? 1, payload, saveKeysRef.current.get(sig))
      if (!result.success) throw new Error(result.error)
      saveKeysRef.current.clear(sig)
      notifyToast(result.data.replayed ? '保存済みでした。' : '保存しました。')
      onSaved(result.data.tag)
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      // 500等は ApiError の内部文（API error: 500）を出さず、既存の保存失敗案内へ。
      { if (!fieldFailure) setError(describeSaveFailure(reason)) }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage title="保管済みタグを直す" busy={saving} dirty={false}
      footerActions={<>
        <Button onClick={onCancel} disabled={saving}>キャンセル</Button>
        <Button variant="primary" onClick={() => save()} disabled={saving || !name.trim()} busy={saving}>保存する</Button>
      </>}>
      <Notice tone="warn">
        <p className="font-bold">このタグは保管済みです</p>
        <p className="mt-1 text-xs leading-5">保管済みのタグは、あとから元に戻す機能がありません。誤字などの表示名の訂正だけできます。フォルダ・付与のしかた・マイル・連動アクションなどの設定は変更できません。</p>
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="タグ名" htmlFor="archived-tag-name"><SaveErrorField names={["name"]}><TextInput id="archived-tag-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></SaveErrorField></Field>
      <Field label="説明" htmlFor="archived-tag-description"><SaveErrorField names={["description"]}><TextArea id="archived-tag-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></SaveErrorField></Field>
    </CreatePage></SaveErrorScope>
  )
}
