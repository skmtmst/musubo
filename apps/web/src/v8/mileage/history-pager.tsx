import Pagination from '@/components/shared/pagination'
import { ListPagePagination } from '@/components/templates'
import { formatNumber } from '@/lib/format'

export default function HistoryPager({ spentOnly, total, page, pageSize, items, pageCount, loading, setPage }: {
  spentOnly: boolean; total: number | null; page: number; pageSize: number; items: { length: number }
  pageCount: number; loading: boolean; setPage: (value: number) => void
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const receivedLast = first + items.length - 1
  const last = total == null ? receivedLast : Math.min(spentOnly ? page * pageSize : receivedLast, total)
  return <ListPagePagination>
    <Pagination page={page} pageCount={Math.max(1, pageCount)} onPageChange={setPage} disabled={loading}
      range={!spentOnly || total !== null ? { total, first, last } : undefined}
      summary={spentOnly && total === null ? `—件のうち、使った・取り消し ${formatNumber(items.length)} 件` : undefined} />
    {spentOnly && total !== null ? <span className="text-body">{`このページのうち、使った・取り消し ${formatNumber(items.length)} 件`}</span> : null}
  </ListPagePagination>
}
