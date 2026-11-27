'use client'

import MediaSlot from '@/components/shared/media-slot'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import {
api
} from '@/lib/api'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import {
RICH_MENU_DIMENSIONS
} from '@line-crm/shared'
import {
BookOpen
} from 'lucide-react'
import type { Dispatch,SetStateAction } from 'react'
import { type Group,type Page,type PendingImage } from './create-types'
import styles from '../../../app/rich-menus/new/create-v8.module.css'

type GetSlotImageContext = {
  accountId: string | null
  group: Group | null
  host: RichMenuCreateHost | undefined
  imageVersion: number
  pages: Page[]
  pendingImages: (PendingImage | null)[]
}

export function getSlotImage({ accountId, group, host, imageVersion, pages, pendingImages }: GetSlotImageContext, index: number): { src: string; name: string; dims: { w: number; h: number } | null; kb: number | null; removable: boolean } | null {
    if (!group) {
      const image = pendingImages[index]
      if (!image) return null
      if (image.media && accountId) {
        return {
          src: api.media.contentUrl(image.media.id, accountId),
          name: image.media.filename,
          dims: image.media.width && image.media.height ? { w: image.media.width, h: image.media.height } : null,
          kb: image.media.sizeBytes !== undefined ? Math.round(image.media.sizeBytes / 1024) : null,
          removable: true,
        }
      }
      if (image.url && image.file) {
        return { src: image.url, name: image.file.name, dims: image.dims, kb: Math.round(image.file.size / 1024), removable: true }
      }
      return null
    }
    const page = pages[index]
    if (!page?.imageR2Key) return null
    const baseUrl = host ? host.imageUrl(page.imageR2Key) : api.richMenuGroups.imageUrl(page.imageR2Key)
    return {
      src: host ? baseUrl : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}v=${imageVersion}`,
      name: '登録した画像',
      dims: null,
      kb: null,
      removable: false,
    }
  }

type RenderSingleImageSlotContext = {
  accountId: string | null
  busy: boolean
  clearPendingImage: (index: number) => void
  handlePickedFile: (file: File | null, tabIndex: number) => void
  host: RichMenuCreateHost | undefined
  setImageGuideOpen: Dispatch<SetStateAction<boolean>>
  setImagePickTarget: Dispatch<SetStateAction<number>>
  setMediaPickerOpen: Dispatch<SetStateAction<boolean>>
  size: "large" | "compact"
  slotImage: (index: number) => { src: string; name: string; dims: { w: number; h: number; } | null; kb: number | null; removable: boolean; } | null
}

export function renderSingleImageSlot({ accountId, busy, clearPendingImage, handlePickedFile, host, setImageGuideOpen, setImagePickTarget, setMediaPickerOpen, size, slotImage }: RenderSingleImageSlotContext) {
    const dims = RICH_MENU_DIMENSIONS[size]
    const image = slotImage(0)
    const imageOk = image?.dims ? image.dims.w === dims.width && image.dims.h === dims.height : null
    const canPick = Boolean(accountId) || Boolean(host)
    const canEdit = canPick && !busy
    return (
      <>
        <div className={styles.imageRow}>
          <div className={styles.imageSlot}>
            <SaveErrorField names={["src","image?.src"]}><MediaSlot
              size="compact"
              fit="contain"
              previewActionsBelow
              title="画像を追加"
              previewAlt={image ? `選択中の画像: ${image.name}` : undefined}
              value={image?.src ?? null}
              accept="image/png,image/jpeg"
              maxBytes={1 * 1024 * 1024}
              aspectRatio={`${dims.width} / ${dims.height}`}
              disabled={!canEdit}
              removable={Boolean(image?.removable)}
              onFile={(file) => { if (canEdit) handlePickedFile(file, 0) }}
              onRemove={() => { if (canEdit) clearPendingImage(0) }}
              onMediaPick={host || !accountId || busy ? undefined : () => { if (!busy) { setImagePickTarget(0); setMediaPickerOpen(true) } }}
            /></SaveErrorField>
          </div>
          <div className={styles.imageMeta}>
            {image ? (
              <>
                <span className="font-semibold text-ink">{image.name}</span>
                <span className={imageOk === true ? styles.imageMetaOk : undefined}>
                  {image.dims ? `${image.dims.w}×${image.dims.h}・` : ''}
                  {image.kb !== null ? `${image.kb}KB` : ''}
                  {imageOk === true ? '・大きさは合っています' : imageOk === false ? '・大きさが合いません' : ''}
                </span>
              </>
            ) : null}
            <button type="button" className={styles.guideLink} onClick={() => setImageGuideOpen(true)}>
              <BookOpen size={16} aria-hidden />画像の作り方（大きさ・押しやすい余白）
            </button>
          </div>
        </div>
        {imageOk === false ? (
          <p className={styles.fieldError} role="alert">
            画像の大きさが合いません。{dims.width}×{dims.height}px の画像を選んでください。
          </p>
        ) : null}
      </>
    )
  }

type RenderTabSlotContext = {
  accountId: string | null
  busy: boolean
  clearPendingImage: (index: number) => void
  group: Group | null
  handlePickedFile: (file: File | null, tabIndex: number) => void
  host: RichMenuCreateHost | undefined
  pages: Page[]
  setImagePickTarget: Dispatch<SetStateAction<number>>
  setMediaPickerOpen: Dispatch<SetStateAction<boolean>>
  size: "large" | "compact"
  slotImage: (index: number) => { src: string; name: string; dims: { w: number; h: number; } | null; kb: number | null; removable: boolean; } | null
  tabNameAt: (index: number) => string
}

export function renderTabSlot({ accountId, busy, clearPendingImage, group, handlePickedFile, host, pages, setImagePickTarget, setMediaPickerOpen, size, slotImage, tabNameAt }: RenderTabSlotContext, index: number) {
    const dims = RICH_MENU_DIMENSIONS[size]
    const image = slotImage(index)
    const imageOk = image?.dims ? image.dims.w === dims.width && image.dims.h === dims.height : null
    const tabName = group ? pages[index]?.name ?? '' : tabNameAt(index)
    const unsaved = Boolean(group && !host && pages[index]?.id.startsWith('tmp-'))
    const canPick = (Boolean(accountId) || Boolean(host)) && !unsaved && !busy
    return (
      <div key={index} className={styles.tabImageSlot}>
        <span className={styles.tabImageHead}>{`タブ${index + 1}「${tabName}」`}</span>
        <SaveErrorField names={["src","image?.src"]}><MediaSlot
          size="compact"
          fit="contain"
          previewActionsBelow
          title={`タブ${index + 1}の画像を追加`}
          previewAlt={image ? `タブ${index + 1}の画像: ${image.name}` : undefined}
          value={image?.src ?? null}
          accept="image/png,image/jpeg"
          maxBytes={1 * 1024 * 1024}
          aspectRatio={`${dims.width} / ${dims.height}`}
          disabled={!canPick}
          removable={Boolean(image?.removable)}
          onFile={(file) => { if (canPick) handlePickedFile(file, index) }}
          onRemove={() => { if (canPick) clearPendingImage(index) }}
          onMediaPick={host || !accountId || !canPick ? undefined : () => { if (canPick) { setImagePickTarget(index); setMediaPickerOpen(true) } }}
        /></SaveErrorField>
        {unsaved ? <p className={styles.fieldHint}>下書きを保存すると、このタブの画像を入れられます。</p> : null}
        {imageOk === false ? (
          <p className={styles.fieldError} role="alert">
            大きさが合いません。{dims.width}×{dims.height}px の画像を選んでください。
          </p>
        ) : null}
      </div>
    )
  }
