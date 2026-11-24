'use client'

import { useEffect, useRef, useState } from 'react'
import { RESTAURANT_COURSE_PHOTO_LIMIT, type Folder, type MediaItem } from '@line-crm/shared'
import { Check, ImageOff } from 'lucide-react'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import FolderSelect, { folderCreator, folderById } from '@/components/shared/folder-select'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { PHOTO_GALLERY_PAGE_SIZE } from '@/components/shared/page-size-options'
import Pagination from '@/components/shared/pagination'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { api } from '@/lib/api'
import MediaUploadDialog, { type RegisteredPhoto } from '@/v8/contents/public/media-upload-dialog'
import styles from './course-photo-picker.module.css'

const UNFILED = '__ungrouped__'
const SORT_OPTIONS = [{ value: 'newest', label: '新しい順' }, { value: 'oldest', label: '古い順' }]
type PickedPhoto = { id: string; source: 'library' | 'file' }
type MediaPage = { items: MediaItem[]; total: number }

function PhotoThumbnail({ item, accountId }: { item: MediaItem; accountId: string }) {
  const [unavailable, setUnavailable] = useState(false)
  return unavailable
    ? <span className={styles.unavailable}><ImageOff size={20} aria-label="画像を表示できません" /></span>
    // アカウント認証つきの画像をブラウザーで読む。
    // eslint-disable-next-line @next/next/no-img-element
    : <img className={styles.thumbnail} src={api.media.contentUrl(item.id, accountId)} alt="" onError={() => setUnavailable(true)} />
}

export default function CoursePhotoPicker({ accountId, existing, onClose, onAdd }: {
  accountId: string
  existing: readonly string[]
  onClose: () => void
  onAdd: (ids: string[]) => void
}) {
  const [selection, setSelection] = useState<PickedPhoto[]>([])
  const [registered, setRegistered] = useState<RegisteredPhoto[]>([])
  const [uploadLimit, setUploadLimit] = useState<number | null>(null)
  const [folderId, setFolderId] = useState('')
  const [folders, setFolders] = useState<Folder[]>([])
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [version, refresh] = useState(0)
  const [results, setResults] = useState<MediaPage | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useEffect(() => {
    let current = true
    void api.folders.list('media', accountId).then(response => {
      if (current && response.success) setFolders(response.data)
    }).catch(() => { /* フォルダ未分類の登録と一覧の写真選択は続けられる。 */ })
    return () => { current = false }
  }, [accountId])

  useEffect(() => {
    if (uploadLimit !== null) return
    let current = true
    setResults(null)
    setLoadFailed(false)
    void api.media.list(accountId, {
      kind: 'image', folderId: folderId || undefined, query: query || undefined,
      sort, limit: PHOTO_GALLERY_PAGE_SIZE, offset: (page - 1) * PHOTO_GALLERY_PAGE_SIZE,
    }).then(response => {
      if (!current) return
      if (!response.success) {
        setLoadFailed(true)
        return
      }
      const { items, total } = response.data
      if (page > 1 && (page - 1) * PHOTO_GALLERY_PAGE_SIZE >= total) {
        setPage(Math.max(1, Math.ceil(total / PHOTO_GALLERY_PAGE_SIZE)))
        return
      }
      setResults({ items: items.filter(item => item.kind === 'image' && item.lineAccountId === accountId && !item.archivedAt), total })
    }).catch(() => { if (current) setLoadFailed(true) })
    return () => { current = false }
  }, [accountId, folderId, page, query, sort, uploadLimit, version])

  const available = Math.max(0, RESTAURANT_COURSE_PHOTO_LIMIT - existing.length)
  const pending = registered.filter(photo => photo.scanStatus === 'pending')
  const rejected = registered.some(photo => photo.scanStatus === 'rejected' || photo.scanStatus === 'quarantined')
  const remaining = Math.max(0, available - selection.length - pending.length)
  const fromFiles = selection.filter(photo => photo.source === 'file').length

  function addRegistered(photos: RegisteredPhoto[]) {
    if (!active.current) return
    setRegistered(current => [...current.filter(photo => !photos.some(updated => updated.id === photo.id)), ...photos])
    setSelection(current => {
      const added = photos.filter(photo => photo.scanStatus === 'clean' && !existing.includes(photo.id) && !current.some(picked => picked.id === photo.id))
      return [...current, ...added.map(({ id }): PickedPhoto => ({ id, source: 'file' }))].slice(0, available)
    })
  }

  async function checkPending() {
    if (checking || pending.length === 0) return
    setChecking(true)
    const results = await Promise.all(pending.map(async photo => {
      try {
        const response = await api.fileScan.forMedia(photo.id, accountId)
        return response.success && response.data.scan ? { ...photo, scanStatus: response.data.scan.status } : photo
      } catch { return photo }
    }))
    if (!active.current) return
    addRegistered(results)
    setChecking(false)
    refresh(current => current + 1)
  }

  function togglePhoto(id: string) {
    if (existing.includes(id) || registered.some(photo => photo.id === id && photo.scanStatus !== 'clean')) return
    setSelection(current => current.some(photo => photo.id === id)
      ? current.filter(photo => photo.id !== id)
      : current.length + pending.length < available
        ? [...current, { id, source: registered.some(photo => photo.id === id) ? 'file' : 'library' }]
        : current)
  }

  if (uploadLimit !== null) {
    return <MediaUploadDialog open accountId={accountId} folders={folders} initialFolderId=""
      onCreateFolder={folderCreator((name, color) => api.folders.create({ kind: 'media', name, color, accountId }),
        folderById, folder => { if (active.current) setFolders(current => [...current, folder]) })}
      photoUpload={{ maxFiles: uploadLimit, onRegistered: addRegistered }}
      onComplete={() => {
        setPage(1)
        setFolderId('')
        setSort('newest')
        setInput('')
        setQuery('')
      }}
      onClose={() => { setUploadLimit(null); void checkPending() }}
    />
  }

  const openUpload = () => setUploadLimit(remaining)
  const fileAction = <Button size="large" onClick={openUpload} disabled={remaining === 0 || checking}>ファイルから追加</Button>
  const filtered = Boolean(query || folderId)
  const total = results?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PHOTO_GALLERY_PAGE_SIZE))

  return <Dialog
    open title="コースの写真を選ぶ" onCancel={onClose}
    designWidth={960} exactDesignWidth designMinHeight={804} contentLayout="form"
    designNode="Go9Us" designContentPadding="0"
    headerAction={<span className={styles.desktopUpload}>{fileAction}</span>}
    footer={<DialogActions summary={(
      <div className={styles.selection}><strong>選択中 {selection.length} / {available}枚{selection.length >= available ? '（上限）' : ''}</strong>
        <span>{fromFiles > 0 ? `登録メディア ${selection.length - fromFiles}枚 ＋ ファイルから登録 ${fromFiles}枚` : 'コースに追加する写真は合計5枚まで。'}</span>
      </div>
    )}>
      <Button size="large" className={styles.cancel} onClick={onClose}>キャンセル</Button>
      <Button size="large" className={styles.apply} variant="primary" disabled={selection.length === 0} onClick={() => onAdd(selection.slice(0, available).map(photo => photo.id))}>
        {selection.length ? `${selection.length}枚を追加` : '写真を追加'}
      </Button>
    </DialogActions>}
  >
    <div className={styles.body}>
      <div className={styles.mobileUpload}><Button size="large" onClick={openUpload} disabled={remaining === 0 || checking} fullWidth>ファイルから追加</Button></div>
      <h3 className={styles.heading}>登録メディア</h3>
      <div className={styles.filters}>
        <div className={styles.filtersGroup}>
          <FolderSelect aria-label="フォルダ" size="full" value={folderId} allOption={{ value: '', label: 'すべてのフォルダ' }}
            unfiled={{ value: UNFILED, label: '未分類' }} folders={folders.map(folderById)}
            onChange={value => { setFolderId(value); setPage(1) }} />
          <Select aria-label="表示順" size="full" value={sort} options={SORT_OPTIONS}
            onChange={value => { setSort(value === 'oldest' ? 'oldest' : 'newest'); setPage(1) }} />
        </div>
        <form className={styles.search} onSubmit={event => { event.preventDefault(); setPage(1); setQuery(input.trim()) }}>
          <TextField aria-label="写真の名前" placeholder="名前で探す" value={input} onChange={event => setInput(event.target.value)} />
          <Button type="submit">検索</Button>
        </form>
      </div>
      {pending.length > 0 ? <Notice tone="info" action={<Button onClick={() => void checkPending()} busy={checking}>読み直す</Button>}>
        検査中の写真が{pending.length}枚あります。確認が終わった写真を選べます。
      </Notice> : null}
      {rejected ? <Notice tone="warn">検査を通らなかった写真は使えません。別の写真を選んでください。</Notice> : null}
      {loadFailed ? <ListState kind="error" title="写真を読み込めませんでした" onRetry={() => refresh(value => value + 1)} /> : !results ? (
        <ListState kind="loading" title="写真を読み込んでいます" />
      ) : results.items.length > 0 ? <>
        <ul className={styles.grid} aria-label="登録メディアの写真">
          {results.items.map(item => {
            const selected = selection.some(photo => photo.id === item.id)
            const alreadyAdded = existing.includes(item.id)
            const blocked = registered.some(photo => photo.id === item.id && photo.scanStatus !== 'clean')
            const checked = selected || alreadyAdded
            const disabled = alreadyAdded || blocked || (!selected && remaining === 0)
            return <li key={item.id} className={selected ? `${styles.photo} ${styles.picked}` : styles.photo}>
              <div aria-hidden="true">
                <PhotoThumbnail item={item} accountId={accountId} />
                <span className={`${styles.check} ${checked ? styles.checked : ''}`}>{checked ? <Check size={15} /> : null}</span>
                <span className={styles.filename}>{item.filename}</span>
              </div>
              <Button variant="text" size="inline" className={styles.choice} aria-label={item.filename} title={item.filename}
                role="checkbox" aria-checked={checked} disabled={disabled} onClick={() => togglePhoto(item.id)}>{null}</Button>
            </li>
          })}
        </ul>
      </> : <ListState kind="empty" title={filtered ? '条件に合う写真がありません' : '選べる写真がありません'} />}
      {results && total > 0 ? <div className={styles.page}>
        <span>{(page - 1) * PHOTO_GALLERY_PAGE_SIZE + 1}–{Math.min(page * PHOTO_GALLERY_PAGE_SIZE, total)} / {total}件</span>
        <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="登録メディアのページ送り" mode="cursor" />
      </div> : null}
    </div>
  </Dialog>
}
