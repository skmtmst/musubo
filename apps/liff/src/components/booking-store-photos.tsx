import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Button from './ui/button/index.js';
import ConfirmDialog from './ui/confirm-dialog.js';
import { PhotoButton, PhotoFrame } from './ui/photo-preview.js';

const labels = { exterior: '外観', interior: '店内', waiting: '待合' };
type Photo = { slot: keyof typeof labels; url: string };

/** 写真は任意。取得失敗は失敗の文を出さず、読み直しの操作だけ残す。 */
export default function BookingStorePhotos() {
  const [selected, setSelected] = useState<Photo | null>(null);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    api.storePhotos().then(rows => {
      if (!Array.isArray(rows) || !rows.every(row => row && Object.hasOwn(labels, row.slot) && typeof row.url === 'string' && row.url.trim())) {
        throw new Error('Invalid store photos response');
      }
      if (alive) setPhotos(rows);
    })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [revision]);
  if (failed) return <section aria-label="お店の案内" className="space-y-3">
    <Button variant="secondary" onClick={() => setRevision(value => value + 1)}>写真を読み直す</Button>
  </section>;
  if (!photos?.length) return null;
  return <section aria-label="お店の案内" className="space-y-3">
    <h2 className="text-sm font-bold text-ink">お店の案内</h2>
    <div className="grid grid-cols-3 gap-3">
      {photos.map(photo => <figure key={photo.slot} className="min-w-0 space-y-1.5">
        <PhotoButton kind="landscape" src={photo.url} label={`${labels[photo.slot]}の写真を大きく見る`}
          description={`お店の${labels[photo.slot]}`} onClick={() => setSelected(photo)} />
        <figcaption className="text-xs text-liff-sub">{labels[photo.slot]}</figcaption>
      </figure>)}
    </div>
    <ConfirmDialog open={selected !== null} title={selected ? `お店の${labels[selected.slot]}` : 'お店の写真'} description="" onCancel={() => setSelected(null)}>
      {selected && <PhotoFrame appearance="intrinsic"><img src={selected.url} alt={`お店の${labels[selected.slot]}（拡大）`} /></PhotoFrame>}
    </ConfirmDialog>
  </section>;
}
