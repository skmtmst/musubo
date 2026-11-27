'use client'

import { createAreaDrafts } from '@/components/rich-menus/action-drafts'
import {
describeApiFailure,
isSaveConflict
} from '@/components/shared/api-error-message'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import {
ApiError,
api
} from '@/lib/api'
import { type HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { TEMPLATES } from '@/lib/rich-menu-templates'
import {
pruneCondition,
type SegmentCondition
} from '@/lib/segment-condition'
import type { Dispatch,SetStateAction } from 'react'
import { areaDraftsWithSwitchTargets,mediaToFile,projectAreaForDraft } from './create-draft'
import { groupFromSeed } from './create-model'
import { type Group,type Page,type PendingImage } from './create-types'
import { imageUploadErrorText } from './image-upload-error'

type CreateMenuDraftContext = {
  accountId: string | null
  audience: "all" | "tag" | "none" | "targeted"
  chatBarText: string
  defaultOpen: boolean
  folderId: string
  host: RichMenuCreateHost | undefined
  hostSeedFromShape: () => Promise<HqRichMenuSeed | null>
  hydrate: (g: Group) => void
  name: string
  pendingImages: (PendingImage | null)[]
  reloadGroup: (groupId: string) => Promise<void>
  saveErrors: Pick<ReturnType<typeof useSaveFormErrors>, 'capture'>
  setError: Dispatch<SetStateAction<string | null>>
  setPendingImages: Dispatch<SetStateAction<(PendingImage | null)[]>>
  size: "large" | "compact"
  tabCount: number
  tabNameAt: (index: number) => string
  targetingCondition: SegmentCondition | null
  targetingPriority: number
  templateKey: string
  validateBasics: () => boolean
}

export async function createMenuDraft({ accountId, audience, chatBarText, defaultOpen, folderId, host, hostSeedFromShape, hydrate, name, pendingImages, reloadGroup, saveErrors, setError, setPendingImages, size, tabCount, tabNameAt, targetingCondition, targetingPriority, templateKey, validateBasics }: CreateMenuDraftContext): Promise<boolean> {
    if (host) {
      const seed = await hostSeedFromShape()
      if (!seed) return false
      hydrate(groupFromSeed(seed))
      return true
    }
    if (!accountId) {
      setError('アカウントを選択してください')
      return false
    }
    if (!validateBasics()) return false
    const template = TEMPLATES.find((t) => t.key === templateKey)
    if (!template) {
      setError('面の分けかたを選び直してください')
      return false
    }
    const areas = areaDraftsWithSwitchTargets(createAreaDrafts(template))
    const condition = audience === 'targeted' ? pruneCondition(targetingCondition) : null
    if (audience === 'targeted' && !condition) {
      setError('出す相手の条件を設定してください。')
      return false
    }
    const res = await api.richMenuGroups.create({
      accountId,
      name: name.trim(),
      chatBarText: chatBarText.trim(),
      size,
      folderId: folderId || null,
      defaultPageIndex: 0,
      isDefaultForAll: audience === 'all',
      targetingEnabled: audience === 'targeted',
      targetingCondition: condition ? JSON.stringify(condition) : null,
      targetingPriority,
      defaultOpen,
      imageMediaId: pendingImages[0]?.media?.id,
      pages: Array.from({ length: tabCount + 1 }, (_, index) => ({
        name: tabNameAt(index),
        orderIndex: index,
        areas,
      })),
    })
    if (!res.success) throw new Error(res.error ?? '作成失敗')
    if (!res.data?.id || !Array.isArray(res.data.pages)) throw new Error('作成失敗')
    const createdId = res.data.id
    // ①で選んだタブごとの画像をそのページへ上げる（最初のページの登録メディアは作るときに渡した）。
    let imageUploadFailed = false
    for (let index = 0; index <= tabCount; index += 1) {
      const image = pendingImages[index]
      const pageId = res.data.pages[index]?.id
      if (!image || !pageId || (index === 0 && image.media && !image.file)) continue
      const fromMedia = !image.file && Boolean(image.media)
      try {
        const file = image.file ?? (image.media && accountId ? await mediaToFile(image.media, accountId) : null)
        if (file) {
          const uploaded = await api.richMenuGroups.uploadImage(createdId, pageId, file)
          if (uploaded && (uploaded as { success?: boolean }).success === false) {
            throw new Error((uploaded as { error?: string }).error || '画像をアップロードできませんでした。')
          }
        }
      } catch (e) {
        imageUploadFailed = true
        const fieldFailure = saveErrors.capture(e)
        // 下書き自体はできている。画像だけ失敗として知らせる。
        if (!fieldFailure) {
          setError(
            e instanceof ApiError
              ? imageUploadErrorText(e)
              : fromMedia
                ? '登録メディアの画像を読み込めませんでした。もう一度お試しください。'
                : describeApiFailure(e, '画像のアップロード', { scope: 'store' }),
          )
        }
      }
    }
    await reloadGroup(createdId)
    pendingImages.forEach((image) => { if (image?.url) URL.revokeObjectURL(image.url) })
    setPendingImages([])
    return !imageUploadFailed
  }

type PersistMenuDraftContext = {
  accountId: string | null
  audience: "all" | "tag" | "none" | "targeted"
  chatBarText: string
  defaultOpen: boolean
  folderId: string
  group: Group | null
  host: RichMenuCreateHost | undefined
  name: string
  pages: Page[]
  targetingCondition: SegmentCondition | null
  targetingPriority: number
}

export async function persistMenuDraft({ accountId, audience, chatBarText, defaultOpen, folderId, group, host, name, pages, targetingCondition, targetingPriority }: PersistMenuDraftContext): Promise<void> {
    if (!group) throw new Error('下書きがまだ作られていません')
    if (host) return
    if (group.accountId !== accountId) throw new Error('この下書きのアカウントへ戻してから保存してください。')
    const condition = audience === 'targeted' ? pruneCondition(targetingCondition) : null
    if (audience === 'targeted' && !condition) {
      throw new Error('出す相手の条件を設定してください。')
    }
    const res = await api.richMenuGroups.update(group.id, {
      expectedVersion: group.version,
      name: name.trim(),
      chatBarText: chatBarText.trim(),
      isDefaultForAll: audience === 'all',
      targetingEnabled: audience === 'targeted',
      targetingPriority,
      targetingCondition: condition ? JSON.stringify(condition) : null,
      folderId: folderId || null,
      defaultOpen,
      pages: pages.map((p, i) => ({
        ...(p.id.startsWith('tmp-') ? {} : { id: p.id }),
        name: p.name,
        orderIndex: i,
        areas: p.areas.map(projectAreaForDraft),
      })),
    })
    if (!res.success) throw new Error(res.error ?? '保存失敗')
  }

type SaveMenuDraftContext = {
  createDraft: () => Promise<boolean>
  group: Group | null
  host: RichMenuCreateHost | undefined
  persistDraft: () => Promise<void>
  reloadGroup: (groupId: string) => Promise<void>
  saveErrors: Pick<ReturnType<typeof useSaveFormErrors>, 'capture'>
  saving: boolean
  setCompareOpen: Dispatch<SetStateAction<boolean>>
  setConflict: Dispatch<SetStateAction<boolean>>
  setConflictLatest: Dispatch<SetStateAction<Group | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setNotice: Dispatch<SetStateAction<string>>
  setSaving: Dispatch<SetStateAction<boolean>>
  validateBasics: () => boolean
}

export async function saveMenuDraft({ createDraft, group, host, persistDraft, reloadGroup, saveErrors, saving, setCompareOpen, setConflict, setConflictLatest, setError, setNotice, setSaving, validateBasics }: SaveMenuDraftContext): Promise<boolean> {
    if (saving) return false
    if (!validateBasics()) return false
    setSaving(true)
    setError(null)
    setNotice('')
    try {
      if (!group) {
        const ok = await createDraft()
        if (!ok) return false
      } else {
        // 切替ボタンの行き先未設定は validateBasics（欄の誤り）で先に止めている（server 400 を日本語で先回り）。
        await persistDraft()
        if (!host) await reloadGroup(group.id)
      }
      if (host) return true
      setNotice('下書きを保存しました。')
      notifyToast('下書きを保存しました')
      return true
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)
      // ★V8 ：ほかの人が先に保存した（409）。入力は残したまま、
      // 帯を出して最新を取り直す。比べる文に使う。
      if (isSaveConflict(e) && group) {
        setConflict(true)
        setCompareOpen(false)
        try {
          const latest = await api.richMenuGroups.get(group.id)
          if (latest.success) setConflictLatest(latest.data as Group)
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          // 取り直しに失敗しても帯は出す。比べる文は出さない。
        }
        return false
      }
      const targetingPriorityInvalid = e instanceof Error && /targetingPriority/.test(e.message)
      { if (!fieldFailure)

      setError(
        targetingPriorityInvalid
          ? '出す順番は1以上の整数で入力してください。小数は使えません。'
          : describeApiFailure(e, '下書きの保存', {
              scope: 'store',
            }),
      ) }
      return false
    } finally {
      setSaving(false)
    }
  }
