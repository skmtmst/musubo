import type { MediaItem } from '@line-crm/shared'
import type { Area } from '../../../components/rich-menus/area-types'
/** 作る前に①で選んだ画像（タブごとに1枚）。ファイルか登録メディアのどちらか。 */
export type PendingImage = {
  file: File | null
  url: string | null
  dims: { w: number; h: number } | null
  media: MediaItem | null
}

/* ---------- 型 ---------- */

export type Page = {
  id: string
  orderIndex: number
  name: string
  aliasId: string
  lineRichmenuId: string | null
  imageR2Key: string | null
  imageContentType: string | null
  areas: Area[]
}

export type Group = {
  id: string
  accountId: string
  name: string
  chatBarText: string
  size: 'large' | 'compact'
  defaultPageId: string | null
  isDefaultForAll: boolean
  status: 'draft' | 'published'
  targetingCondition: string | null
  targetingPriority: number
  targetingEnabled: boolean
  folderId: string | null
  defaultOpen: boolean
  version: number
  publishingGeneration: number
  pages: Page[]
}

export type CheckState = 'ok' | 'ng' | 'yet'

export type PrepublishState = {
  self: { state: 'ok' | 'ng'; message: string | null }
  line: { state: CheckState; message: string | null }
  device: { state: 'ok' | 'yet'; at: string | null }
  pages: { state: 'ok' | 'ng'; count: number; max: number }
}
