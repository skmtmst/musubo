import { useEffect, useRef, useState, type KeyboardEvent, type TouchEvent } from 'react';
import Button from '../../components/ui/button/index.js';
import ConfirmDialog from '../../components/ui/confirm-dialog.js';
import Icon from '../../components/ui/icon.js';
import { PhotoButton, PhotoFrame } from '../../components/ui/photo-preview.js';
import type { RestaurantMenuItem } from '../../lib/api.js';
import styles from './menu.module.css';

export default function PhotoGallery({
  item,
  onClose,
  refreshPhoto,
}: {
  item: RestaurantMenuItem;
  onClose: () => void;
  refreshPhoto: (photoId: string) => Promise<string | null>;
}) {
  const [index, setIndex] = useState(0);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<Record<number, { url: string; revision: number }>>({});
  const [failures, setFailures] = useState<Record<number, string>>({});
  const touch = useRef<{ x: number; y: number } | null>(null);
  const gallery = useRef<HTMLDivElement>(null);
  const thumbs = useRef<Array<HTMLButtonElement | null>>([]);
  const photo = item.photos[index]!;
  const photoUrl = overrides[index]?.url ?? photo.url;
  const photoKey = JSON.stringify([photoUrl, overrides[index]?.revision]);
  const count = item.photos.length;

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = originalOverflow; };
  }, []);

  useEffect(() => {
    thumbs.current[index]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [index]);

  function step(offset: number) {
    setIndex((current) => Math.max(0, Math.min(count - 1, current + offset)));
  }

  function moveViaKey(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  }

  function swipe(event: TouchEvent) {
    const start = touch.current;
    touch.current = null;
    const end = event.changedTouches[0];
    if (!start || !end) return;
    const horizontal = end.clientX - start.x;
    const vertical = end.clientY - start.y;
    if (Math.abs(horizontal) > 42 && Math.abs(horizontal) > Math.abs(vertical)) step(horizontal < 0 ? 1 : -1);
  }

  async function retry(trigger: HTMLButtonElement) {
    if (retrying !== null) return;
    setRetrying(index);
    try {
      const url = await refreshPhoto(photo.id);
      if (url) {
        if (document.activeElement === trigger || document.activeElement === document.body) {
          gallery.current?.focus({ preventScroll: true });
        }
        setOverrides((current) => ({ ...current, [index]: { url, revision: (current[index]?.revision ?? 0) + 1 } }));
      }
    } catch {
      // ほかの写真の表示を保ち、同じ写真だけ再試行できるようにする。
    } finally {
      setRetrying(null);
    }
  }

  return (
    <ConfirmDialog open title={item.name} onCancel={onClose} appearance={count > 1 ? 'photo-with-thumbnails' : 'photo'}
      titleAside={count > 1 && <span className="shrink-0 text-xs leading-6 font-semibold text-liff-sub" aria-live="polite">{index + 1} / {count}</span>}>
      <div ref={gallery} onKeyDown={moveViaKey} tabIndex={count > 1 ? 0 : -1}>
        <PhotoFrame appearance="inset"
          onTouchStart={(event) => {
            const point = event.touches[0];
            touch.current = count > 1 && event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY } : null;
          }}
          onTouchEnd={swipe}
          onTouchCancel={() => { touch.current = null; }}>
          {failures[index] === photoKey ? (
            <div className="flex w-full max-w-54 flex-col items-center gap-3 px-4 text-center">
              <Icon name="image" className="h-7 w-7 text-liff-sub" />
              <p role="status" className="text-[13px]">写真を読み込めませんでした</p>
              <Button variant="secondary" disabled={retrying !== null} onClick={(event) => void retry(event.currentTarget)}>
                もう一度読み込む
              </Button>
            </div>
          ) : (
            <img key={photoKey} src={photoUrl} alt={`${item.name}の写真 ${index + 1}`} decoding="async"
              onError={() => setFailures((current) => ({ ...current, [index]: photoKey }))} />
          )}
        </PhotoFrame>
        {count > 1 && (
          <div className={styles.photoStrip} aria-label="写真を選ぶ" role="group">
            {item.photos.map((entry, photoIndex) => (
              <PhotoButton key={entry.id} ref={(node) => { thumbs.current[photoIndex] = node; }} kind="thumbnail"
                src={overrides[photoIndex]?.url ?? entry.url} version={overrides[photoIndex]?.revision}
                crop={entry} selected={photoIndex === index}
                label={`写真 ${photoIndex + 1} を表示`} onClick={() => setIndex(photoIndex)} />
            ))}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
