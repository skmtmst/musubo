'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { ManualPublishAttempt } from '@/v8/rich-menus/edit/manual-publish-attempt'
import {
clearPublishPlanDraft
} from '@/v8/rich-menus/edit/publish-plan-draft'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api, ApiError } from '@/lib/api'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { type Group } from './create-types'


type PublishMenuNowContext = {
  audience: "all" | "tag" | "none" | "targeted"
  group: Group | null
  confirmedImages: Array<{orderIndex:number;imageR2Key:string|null;imageContentType:string|null}>
  loadChecks: () => Promise<void>
  persistDraft: () => Promise<void>
  publishAttempt: RefObject<ManualPublishAttempt>
  publishing: boolean
  reloadGroup: (groupId: string) => Promise<void>
  saveErrors: Pick<ReturnType<typeof useSaveFormErrors>, 'capture'>
  saving: boolean
  setDone: Dispatch<SetStateAction<"scheduled" | "published" | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setNotice: Dispatch<SetStateAction<string>>
  setPublishing: Dispatch<SetStateAction<boolean>>
}

export async function publishMenuNow({ audience, group, confirmedImages, loadChecks, persistDraft, publishAttempt, publishing, reloadGroup, saveErrors, saving, setDone, setError, setNotice, setPublishing }: PublishMenuNowContext) {
    if (!group || publishing || saving) return
    const idempotencyKey = publishAttempt.current.begin()
    if (!idempotencyKey) return
    setPublishing(true)
    setError(null)
    setNotice('')
    let draftSaved = false
    try {
      await persistDraft()
      draftSaved = true
      // 保存で内容が変わると実機確認の fingerprint が変わる。保存し直した状態で再確認する。
      await loadChecks()
      await reloadGroup(group.id)
      const res = await api.richMenuGroups.publish(group.id, idempotencyKey,{expectedVersion:group.version+1,expectedPublishGeneration:group.publishingGeneration,expectedImages:confirmedImages})
      if (!res.success) throw new Error(res.error ?? 'publish failed')
      publishAttempt.current.succeed()
      setDone('published')
      setNotice(
        audience === 'all'
          ? 'LINEへの登録が終わり、すべての友だちの既定メニューになりました。'
          : audience === 'none'
            ? 'LINEへの登録が終わりました。この操作だけでは、友だちの画面は変わりません。出す相手は一覧の「表示先」から操作してください。'
            : 'LINEへの登録が終わりました。条件に当てはまる人の画面には、その人に関係する出来事（友だち追加・タグ付けなど）が起きたタイミングで順次出ます。',
      )
      notifyToast(
        audience === 'all'
          ? 'すべての友だちの既定メニューになりました'
          : 'LINEへの登録が終わりました',
      )
      clearPublishPlanDraft(group.id)
      void reloadGroup(group.id).catch(cause => setError(describeApiFailure(cause, '読み込み')))
      return true
    } catch (e) {
      if(e instanceof ApiError&&e.code==='RICH_MENU_PUBLISH_CHANGED')publishAttempt.current.succeed()
      const fieldFailure = saveErrors.capture(e);

      const targetingPriorityInvalid = e instanceof Error && /targetingPriority/.test(e.message)
      const isValidationMessage = e instanceof Error && /[ぁ-んァ-ヶ一-龠]/u.test(e.message) && e.message !== 'publish failed'
      { if (!fieldFailure)

      setError(
        targetingPriorityInvalid
          ? '出す順番は1以上の整数で入力してください。小数は使えません。'
          : isValidationMessage
            ? describeApiFailure(e, '公開')
            : draftSaved
              ? 'LINEへ登録できませんでした。下書きは保存済みです。LINEへの登録だけもう一度お試しください。'
              : 'LINEへ登録できませんでした。下書きは保存されていません。しばらくおいてから、もう一度お試しください。',
      ) }
      void loadChecks()
      return false
    } finally {
      setPublishing(false)
      publishAttempt.current.finish()
    }
  }
