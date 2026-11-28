import { useState, type HTMLAttributes, type MouseEventHandler, type ReactNode, type Ref } from 'react';
import Button from './button/index.js';
import styles from './photo-preview.module.css';

export function PhotoButton({ kind, src, version = 0, label, description = '', crop, caption, selected, onClick, ref }: {
  kind: 'landscape' | 'cover' | 'thumbnail';
  src: string;
  version?: number;
  label: string;
  description?: string;
  crop?: { x: number; y: number };
  caption?: string;
  selected?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}) {
  const [failedImage, setFailedImage] = useState<{ src: string; version: number }>();
  const failed = failedImage?.src === src && failedImage.version === version;
  const eager = kind === 'thumbnail';
  return (
    <Button variant="plain" className={`${styles[kind]}${selected ? ` ${styles.selected}` : ''}`}
      selected={selected} aria-pressed={selected} aria-label={label} onClick={onClick} ref={ref}>
      {!failed && <img key={version} src={src} alt={description} loading={eager ? undefined : 'lazy'} decoding={kind === 'landscape' ? undefined : 'async'}
        style={crop ? { objectPosition: `${crop.x}% ${crop.y}%` } : undefined}
        onError={kind === 'landscape' ? undefined : () => setFailedImage({ src, version })} />}
      {caption && <span className={styles.caption}>{caption}</span>}
    </Button>
  );
}

/** 写真全体が見える枠。元の縦横比を変えずに収める。 */
export function PhotoFrame({ appearance, children, ...events }: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> & {
  appearance: 'inset' | 'intrinsic';
  children: ReactNode;
}) {
  return <div className={styles[appearance]} {...events}>{children}</div>;
}
