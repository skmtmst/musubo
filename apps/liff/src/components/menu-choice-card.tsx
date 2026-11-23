import type { ReactNode } from 'react';
import Button from './ui/button/index.js';
import Icon from './ui/icon.js';

/** サロンのメニューと飲食のコースで共通の写真付き選択肢。 */
export default function MenuChoiceCard({ name, description, imageUrl, selected, details, onSelect, disabled = false, emptyImagePlaceholder = true }: { name: string; description?: string | null; imageUrl?: string | null; selected: boolean; details: ReactNode; onSelect: () => void; disabled?: boolean; emptyImagePlaceholder?: boolean }) {
  return <Button variant="option" selected={selected} type="button" onClick={onSelect} aria-pressed={selected} disabled={disabled}>
    {imageUrl ? <img src={imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-[10px] object-cover" /> : emptyImagePlaceholder ? <span className="h-14 w-14 shrink-0 rounded-[10px] bg-liff-photo" aria-hidden="true" /> : null}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[15px] leading-[22px] font-bold text-ink" title={name}>{name}</span>
      {description ? <span className="mt-[3px] block truncate text-[11.5px] leading-[17px] text-liff-sub" title={description}>{description}</span> : null}
      <span className="mt-[3px] block text-xs">{details}</span>
    </span>
    {selected ? <Icon name="circle-check" className="h-[22px] w-[22px] shrink-0 text-liff-primary" /> : <Icon name="chevron-right" className="h-[18px] w-[18px] shrink-0 text-liff-idle" />}
  </Button>;
}
