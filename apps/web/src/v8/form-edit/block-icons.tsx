import {
  Armchair, Cake, CalendarCheck, CalendarDays, ChevronDown, CircleDot, Clock, Hash, Heading, HelpCircle,
  Image, Languages, Mail, MapPin, Minus, MousePointerClick, Paperclip, Phone, Pilcrow,
  ShieldCheck, SquareCheck, Star, Type, User, type LucideIcon,
} from 'lucide-react'
import type { FormBlock } from '@line-crm/shared'

const icons: Record<string, LucideIcon> = {
  radio: CircleDot, checkbox: SquareCheck, select: ChevronDown, rating: Star,
  text: Minus, textarea: Pilcrow, contact: Mail, tel: Phone, address: MapPin,
  name: User, kana: Languages, birthday: Cake, age: Hash, allergy: ShieldCheck,
  anniversary: CalendarDays, seat_preference: Armchair, date: CalendarDays,
  time: Clock, booking: CalendarCheck, file: Paperclip,
  image: Image, heading: Heading, 'text-deco': Type, button: MousePointerClick,
}

export const formKindIcon = (kind: string): LucideIcon =>
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(icons, kind) ? icons[kind] : HelpCircle

export function formBlockIcon(block: FormBlock) {
  if (!block || typeof block !== 'object') return <HelpCircle size={16} aria-hidden="true" />
  const Icon = formKindIcon(block.kind === 'input'
    ? block.fixedField ?? block.type
    : block.kind === 'text' ? 'text-deco' : block.kind)
  return <Icon size={16} aria-hidden="true" />
}
