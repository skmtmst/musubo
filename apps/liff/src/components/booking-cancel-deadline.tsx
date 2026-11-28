import { formatDateTimeLong } from '../lib/datetime.js';

export default function BookingCancelDeadline({ deadline }: { deadline?: string | null }) {
  return deadline ? <p className="text-xs text-ink-secondary">{Number.isFinite(Date.parse(deadline)) ? `キャンセル期限：${formatDateTimeLong(deadline)}` : 'キャンセル期限を確認できません'}</p> : null;
}
