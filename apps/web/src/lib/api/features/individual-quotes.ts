import { fetchApi } from '../transport/request'
import type { ApiResponse, MusuboIndividualQuote } from '@line-crm/shared'

type QuoteStatus = 'draft' | 'sending' | 'sent' | 'accepted' | 'superseded' | 'expired'
type QuoteRow = { quote: MusuboIndividualQuote; status: QuoteStatus; revision?: number; sentAt?: string | null }
type QuoteAccess = 'available' | 'expired' | 'accepted' | 'superseded'
type Proposed = Omit<MusuboIndividualQuote,
  'quoteNumber' | 'companyName' | 'issuedAt' | 'acceptedAt' | 'supersededAt'>

const applicationBase = (applicationId: string) =>
  `/api/ops/applications/${encodeURIComponent(applicationId)}/quotes`
const quotePath = (id: string) => `/api/hq/onboarding/quotes/${encodeURIComponent(id)}`

export const individualQuoteMethods = {
  individualQuotes: {
    customer: {
      get: (id: string) => fetchApi<ApiResponse<{
        quote: MusuboIndividualQuote; access: QuoteAccess; cardRegistrationAvailable: boolean
      }>>(quotePath(id)),
      latest: () => fetchApi<ApiResponse<{ quoteId: string }>>('/api/hq/onboarding/quotes/latest'),
      accept: (id: string) => fetchApi<ApiResponse<{ quote: MusuboIndividualQuote; accepted: boolean }>>(
        `${quotePath(id)}/accept`, { method: 'POST' }),
    },
    operations: {
      list: (applicationId: string) => fetchApi<ApiResponse<QuoteRow[]>>(applicationBase(applicationId)),
      create: (applicationId: string, proposed: Proposed) => fetchApi<ApiResponse<QuoteRow>>(
        applicationBase(applicationId), { method: 'POST', body: JSON.stringify({ proposed }) }),
      update: (applicationId: string, id: string, proposed: Proposed) => fetchApi<ApiResponse<QuoteRow>>(
        `${applicationBase(applicationId)}/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify({ proposed }) }),
      mailPreview: (applicationId: string, id: string) => fetchApi<ApiResponse<{
        to: string; subject: string; text: string; html: string; quoteId: string;
        kind: 'issued' | 'reissued'; previewHash: string
      }>>(`${applicationBase(applicationId)}/${encodeURIComponent(id)}/mail-preview`),
      send: (applicationId: string, id: string, previewHash: string) => fetchApi<ApiResponse<{
        quoteId: string; status: 'sent'; recipient: string
      }>>(`${applicationBase(applicationId)}/${encodeURIComponent(id)}/send`,
        { method: 'POST', body: JSON.stringify({ previewHash }) }),
    },
  },
}
