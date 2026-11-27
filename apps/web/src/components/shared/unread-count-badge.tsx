import styles from './unread-count-badge.module.css'

/** 数を確認できない旧API応答は、数を推測せず未読だけを示す。 */
export default function UnreadCountBadge({ count, id, className }: { count?: number; id?: string; className?: string }) {
  if (count !== undefined && count <= 0) return null
  const label = count === undefined ? '未読' : `未読 ${count}件`
  return <span id={id} className={[styles.badge, className].filter(Boolean).join(' ')} aria-label={label} title={label}>
    {count === undefined ? '•' : count >= 99 ? '99+' : count}
  </span>
}
