'use client'

/*
 * ★V8 書く欄の左下のクリップ（「7. 添付（左下のクリップから開く）」I7Skn・）。
 *
 * 押すと小窓で「画像・動画」「ファイル」を選ぶ。選んだ口に合う形式だけを
 * ファイルを選ぶ窓に出し、選んだものは親（書く欄）へ渡す。形式・大きさの
 * 確かめ（attachments.ts）とアップロードは親が受け持つ。
 */
import { useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Paperclip } from 'lucide-react'
import MenuPortal from '@/components/shared/menu-portal'
import Button from '@/components/shared/button'
import MediaSlot from '@/components/shared/media-slot'
import { FILE_ACCEPT, MEDIA_ACCEPT, type AttachSlot } from './attachments'
import styles from './inbox-chat.module.css'

export default function AttachMenu({
  disabled,
  onPick,
}: {
  disabled?: boolean
  /** 選んだファイルと、押した口（画像・動画／ファイル）。 */
  onPick: (file: File, slot: AttachSlot) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const mediaRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const choose = (slot: AttachSlot) => {
    setOpen(false)
    ;(slot === 'media' ? mediaRef : fileRef).current?.click()
  }

  return (
    <div ref={wrapRef} className={styles.popWrap}>
      <Button
        type="button"
        size="compact"
        className={styles.attachTrigger}
        aria-label="添付するものを選択する"
        title="画像・動画・ファイルを添付"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((now) => !now)}
      >
        <Paperclip aria-hidden size={16} />
      </Button>
      <MediaSlot title="画像・動画を添付" accept={MEDIA_ACCEPT} fileInputRef={mediaRef} renderTrigger={() => null} onFile={(file) => onPick(file, 'media')} />
      <MediaSlot kind="file" title="ファイルを添付" accept={FILE_ACCEPT} fileInputRef={fileRef} renderTrigger={() => null} onFile={(file) => onPick(file, 'file')} />
      <MenuPortal open={open} align="start" getAnchor={() => wrapRef.current} onClose={() => setOpen(false)}>
        <div role="menu" aria-label="添付するもの" className={styles.attachPop}>
          <button type="button" role="menuitem" className={styles.attachItem} onClick={() => choose('media')}>
            <ImageIcon aria-hidden className={styles.attachItemIcon} />
            <span className={styles.attachItemText}>
              <span className={styles.attachItemTitle}>画像・動画</span>
              <span className={styles.attachItemNote}>JPEG・PNG・MP4。LINE の画像・動画として届く</span>
            </span>
          </button>
          <button type="button" role="menuitem" className={styles.attachItem} onClick={() => choose('file')}>
            <FileText aria-hidden className={styles.attachItemIcon} />
            <span className={styles.attachItemText}>
              <span className={styles.attachItemTitle}>ファイル</span>
              <span className={styles.attachItemNote}>PDF など。ダウンロードのリンクとして届く</span>
            </span>
          </button>
        </div>
      </MenuPortal>
    </div>
  )
}
