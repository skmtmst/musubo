'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { createAreaDrafts } from '@/components/rich-menus/action-drafts'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { type HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { TEMPLATES } from '@/lib/rich-menu-templates'
import type { Dispatch,SetStateAction } from 'react'
import { type PendingImage } from './create-types'



type SeedMenuShapeContext = {
  audience: "all" | "tag" | "none" | "targeted"
  chatBarText: string
  defaultOpen: boolean
  folderId: string
  host: RichMenuCreateHost | undefined
  hqTagName: string
  name: string
  pendingImages: (PendingImage | null)[]
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setError: Dispatch<SetStateAction<string | null>>
  size: "large" | "compact"
  tabCount: number
  tabNameAt: (index: number) => string
  targetingPriority: number
  templateKey: string
  validateBasics: () => boolean
}

export async function seedMenuShape({ audience, chatBarText, defaultOpen, folderId, host, hqTagName, name, pendingImages, saveErrors, setError, size, tabCount, tabNameAt, targetingPriority, templateKey, validateBasics }: SeedMenuShapeContext): Promise<HqRichMenuSeed | null> {
    if (!host || !validateBasics()) return null
    const template = TEMPLATES.find((t) => t.key === templateKey)
    if (!template) {
      setError('面の分けかたを選び直してください')
      return null
    }
    if (!Number.isInteger(tabCount) || tabCount < 0 || tabCount > 2) {
      setError('タブの数を選び直してください')
      return null
    }
    if (!Number.isFinite(targetingPriority)) {
      setError('表示順を確認してください')
      return null
    }
    const imageKeys: Array<string | null> = []
    for (let index = 0; index <= tabCount; index += 1) {
      const file = pendingImages[index]?.file ?? null
      if (!file) {
        imageKeys.push(null)
        continue
      }
      try {
        imageKeys.push((await host.uploadImage(file, size)).r2Key)
      } catch (e) {
        const fieldFailure = saveErrors.capture(e)

        { if (!fieldFailure)

        setError(describeApiFailure(e, '画像の登録')) }
        return null
      }
    }
    const shapePages = Array.from({ length: tabCount + 1 }, (_, index) => ({
      id: `page-${index + 1}`,
      name: tabNameAt(index),
      imageR2Key: imageKeys[index] ?? null,
      areas: createAreaDrafts(template).map((area, areaIndex) => ({ ...area, id: `p${index + 1}-a${areaIndex + 1}` })),
    }))
    return { id: host.initial?.id, name: name.trim(), chatBarText: chatBarText.trim(), folderId: folderId || null, size, displayAudience: audience === 'all' ? 'all' : audience === 'tag' ? 'tag' : 'store', displayTagName: audience === 'tag' ? hqTagName.trim() : '', defaultOpen, displayOrder: targetingPriority, defaultPageId: shapePages[0].id, pages: shapePages }
  }
