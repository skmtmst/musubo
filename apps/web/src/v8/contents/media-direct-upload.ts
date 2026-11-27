/* ★V8 写し：src/app/contents/media-direct-upload.ts から写した（src/v8 は src/app を import しない決まり）。中身は同じ。直すときは両方を直す。 */
import type { MediaItem } from '@line-crm/shared'
import type { MediaUploadSession } from '@/lib/api'

const MEBIBYTE = 1024 * 1024

/*
 * 新規登録で受け付ける形式。口（worker の DIRECT_ALLOWED）と同じ列挙。
 * `image/*` のような前方一致にすると、口に無い形式（SVG・WAVなど）を
 * 選んだ時点で弾けず、まとめて送った口の400で有効なファイルまで巻き込む。
 * 口側へ形式を足したらここも足す。容量の上限も口と同じ値に揃える。
 */
const MEDIA_SPECS: Record<string, { ext: readonly string[]; maxBytes: number }> = Object.assign(Object.create(null), {
  'image/png': { ext: ['png'], maxBytes: 10 * MEBIBYTE },
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: 10 * MEBIBYTE },
  'image/gif': { ext: ['gif'], maxBytes: 10 * MEBIBYTE },
  'image/webp': { ext: ['webp'], maxBytes: 10 * MEBIBYTE },
  'video/mp4': { ext: ['mp4'], maxBytes: 200 * MEBIBYTE },
  'audio/mpeg': { ext: ['mp3'], maxBytes: 200 * MEBIBYTE },
  'audio/mp4': { ext: ['m4a'], maxBytes: 200 * MEBIBYTE },
  'application/pdf': { ext: ['pdf'], maxBytes: 20 * MEBIBYTE },
})

export const MEDIA_ACCEPT = Object.keys(MEDIA_SPECS).join(',')

export function mediaFileLimitBytes(file: Pick<File, 'type'>): number | null {
  return MEDIA_SPECS[file.type]?.maxBytes ?? null
}

function extensionOfFilename(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function validateMediaFile(file: Pick<File, 'name' | 'size' | 'type'>): string {
  const spec = MEDIA_SPECS[file.type]
  if (!spec) return 'この形式は登録できません'
  // 口は拡張子も見る（`spec.ext.includes(ext)`）。中身PNGに `.jpg` など
  // 食い違う名前は選んだ時点で断り、有効なファイルの足を引っ張らせない。
  if (!spec.ext.includes(extensionOfFilename(file.name))) {
    return '拡張子が中身の形式と合っていません'
  }
  if (file.size < 1) return '中身が空のファイルは登録できません'
  if (file.size > spec.maxBytes) return `${Math.round(spec.maxBytes / MEBIBYTE)}MBを超えています`
  return ''
}

export function mediaAcceptForKind(kind: MediaItem['kind']): string {
  if (kind === 'image') return 'image/png,image/jpeg,image/gif,image/webp'
  if (kind === 'video') return 'video/mp4'
  if (kind === 'audio') return 'audio/mpeg,audio/mp4'
  return 'application/pdf'
}

/*
 * 版追加の事前検査。`image/*` のような前方一致にすると、口（`DIRECT_ALLOWED`）
 * に無い形式（SVGなど）を選んだ時点で弾けず、口で400になる。口と同じ列挙にし、
 * 選んだ時点で弾く。口側へ形式を足したらここも足す。
 */
const KIND_MIME_TYPES: Record<MediaItem['kind'], readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  video: ['video/mp4'],
  audio: ['audio/mpeg', 'audio/mp4'],
  file: ['application/pdf'],
}

export function fileMatchesMediaKind(file: Pick<File, 'type'>, kind: MediaItem['kind']): boolean {
  return KIND_MIME_TYPES[kind].includes(file.type)
}

export type MediaMetadataInput = {
  width?: number
  height?: number
  durationMs?: number
  pageCount?: number
  codec?: string
}

/**
 * 版追加の互換判定に使う内容情報を、選択した実ファイルから読む。
 * 読めない環境・形式では undefined のまま返し、API 側が「判定材料不足」
 * として明示的に拒否する（ここで推測して埋めない）。
 */
export async function extractMediaMetadata(file: File): Promise<MediaMetadataInput> {
  const codec = /;\s*codecs="?([^";]+)"?/i.exec(file.type)?.[1]
  if (file.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file)
      const result: MediaMetadataInput = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return codec ? { ...result, codec } : result
    } catch {
      return codec ? { codec } : {}
    }
  }
  if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
    const durationMs = await new Promise<number | undefined>((resolve) => {
      let url = ''
      const finish = (value: number | undefined) => {
        clearTimeout(timer)
        if (url) URL.revokeObjectURL(url)
        resolve(value)
      }
      // loadedmetadata が来ない環境で準備自体が止まらないよう打ち切る
      const timer = setTimeout(() => finish(undefined), 10_000)
      try {
        url = URL.createObjectURL(file)
        const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
        el.preload = 'metadata'
        el.onloadedmetadata = () => {
          const seconds = el.duration
          finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined)
        }
        el.onerror = () => finish(undefined)
        el.src = url
      } catch {
        finish(undefined)
      }
    })
    return { durationMs, codec }
  }
  if (file.type === 'application/pdf') {
    try {
      const text = await file.text()
      const pageCount = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length
      return pageCount > 0 ? { pageCount, codec } : { codec }
    } catch {
      return codec ? { codec } : {}
    }
  }
  return codec ? { codec } : {}
}

/**
 * 署名URLは秘密値なので保持・記録せず、この1回のPUTにだけ使う。
 * XMLHttpRequestを使うのはファイル単位の送信進捗を表示するため。
 */
export function putMediaFile(
  session: MediaUploadSession,
  file: File,
  onProgress: (progress: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(session.method, session.uploadUrl)
    for (const [name, value] of Object.entries(session.requiredHeaders)) {
      request.setRequestHeader(name, value)
    }
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    }
    request.onerror = () => reject(new Error('ファイルを送信できませんでした。時間をおいて、もう一度お試しください。'))
    request.onabort = () => reject(new Error('ファイルの送信を取り消しました'))
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error('ファイルを送信できませんでした。時間をおいて、もう一度お試しください。'))
        return
      }
      const etag = request.getResponseHeader('ETag')?.trim()
      if (!etag) {
        reject(new Error('送信したファイルを確認できませんでした。時間をおいて、もう一度お試しください。'))
        return
      }
      onProgress(100)
      resolve(etag)
    }
    request.send(file)
  })
}
