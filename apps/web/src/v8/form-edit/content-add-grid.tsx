import type { FormBlock } from '@line-crm/shared'
import {
AlarmClock,
AlignLeft,
Armchair,
Cake,
Calendar,
CalendarCheck,
ChevronDown,
CircleDot,
Gift,
Hash,
Heading,
HelpCircle,
Image as ImageIcon,
Languages,
Mail,
MapPin,
Minus,
MousePointerClick,
Paperclip,
Phone,
Pilcrow,
Plus,
ShieldAlert,
SquareCheck,
Star,
Type,
User
} from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './edit.module.css'
import { ADD_GROUPS } from './model'
export function blockIcon(block: FormBlock): ReactNode {
  if (!block || typeof block !== 'object') return <HelpCircle size={16} aria-hidden="true" />
  switch (block.kind) {
    case 'image': return <ImageIcon size={16} aria-hidden="true" />
    case 'heading': return <Heading size={16} aria-hidden="true" />
    case 'text': return <AlignLeft size={16} aria-hidden="true" />
    case 'button': return <MousePointerClick size={16} aria-hidden="true" />
    default:
      // 絵の：5段階は星、ファイルはクリップ、自由に書くは段落の印、予約はカレンダー、ほかの質問は「？」。
      if (block.type === 'booking') return <CalendarCheck size={16} aria-hidden="true" />
      if (block.type === 'rating') return <Star size={16} aria-hidden="true" />
      if (block.type === 'file') return <Paperclip size={16} aria-hidden="true" />
      if (block.type === 'textarea') return <Pilcrow size={16} aria-hidden="true" />
      return <HelpCircle size={16} aria-hidden="true" />
  }
}

export const ADD_CARD_ICONS: Record<string, ReactNode> = Object.assign(
  Object.create(null) as Record<string, ReactNode>,
  Object.fromEntries(Object.entries({
    radio: CircleDot, checkbox: SquareCheck, select: ChevronDown, rating: Star,
    text: Minus, textarea: Pilcrow, contact: Mail, tel: Phone, address: MapPin,
    name: User, kana: Languages, birthday: Cake, age: Hash, allergy: ShieldAlert,
    anniversary: Gift, seat_preference: Armchair,
    date: Calendar, time: AlarmClock, booking: CalendarCheck, file: Paperclip,
    image: ImageIcon, heading: Heading, 'text-deco': Type, button: MousePointerClick,
  }).map(([key, Icon]) => [key, <Icon key={key} size={16} aria-hidden="true" />])),
)

export function AddGrid({ onAdd, hide, note }: { onAdd: (make: (count: number) => FormBlock) => void; hide?: ReadonlySet<string>; note?: string }) {
  return (
    <div className={styles.addBox}>
      <p className={styles.addTitle}>ブロックを足す</p>
      {note ? <p className={styles.addNote}>{note}</p> : null}
      {ADD_GROUPS.map((group) => (
        <div key={group.title} className={styles.addGroup}>
          <p className={styles.addGroupTitle}>{group.title}</p>
          <div className={styles.addCards} data-writing={group.title === '書いてもらう' || undefined}>
            {group.cards.filter((card) => !hide?.has(card.key)).map((card) => (
              <button key={card.key} type="button" className={styles.addCard} data-fresh={card.fresh || undefined} onClick={() => onAdd(card.make)}>
                <span className={styles.addCardTop}>
                  {ADD_CARD_ICONS[card.key] ?? <Plus size={16} aria-hidden="true" />}
                  <span className={styles.addCardLabel}>{card.label}</span>
                  {card.fresh ? <span className={styles.newBadge}>新</span> : null}
                </span>
                <span className={styles.addCardHint} title={card.hint}>{card.hint}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
