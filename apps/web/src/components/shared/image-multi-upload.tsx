'use client'

import { FileUp } from 'lucide-react'
import Button from './button'
import FileDropzone from './file-drop'

/** 画像の複数選択へ1枚ずつ追加する入口。形式・案内・選択の受け渡しを共有する。 */
export default function ImageMultiUpload({ presentation, disabled, busy, onUpload, onPickLibrary }: {
  presentation: 'reference' | 'library'
  disabled?: boolean
  busy?: boolean
  onUpload: (file: File) => void
  onPickLibrary?: () => void
}) {
  const reference = presentation === 'reference'
  return <FileDropzone
    variant="upload"
    icon={<FileUp aria-hidden="true" size={20} style={{ width: 24, height: 24 }} className={reference ? 'text-ink-secondary' : undefined} />}
    title={reference ? '参照画像を追加' : '手元の画像を追加'}
    hint={reference ? <>ドラッグ＆ドロップ<br />またはクリックしてファイルをアップロード<br />（1ファイル10メガバイト以内・PNG・JPEG・WebP）</> : <>ドラッグ＆ドロップ<br />またはクリック<br />10MB 以内・PNG・JPEG・WebP</>}
    accept="image/png,image/jpeg,image/webp"
    disabled={disabled}
    busy={busy}
    aria-label="参照画像のファイルを選ぶ"
    secondary={onPickLibrary ? <Button variant="text" textTone="accent" disabled={disabled || busy} onClick={onPickLibrary}>ライブラリから選択する</Button> : undefined}
    onFiles={files => { if (files[0]) onUpload(files[0]) }}
  />
}
