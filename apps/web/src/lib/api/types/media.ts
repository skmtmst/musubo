export type MediaQuota = {
  usageBytes: number
  reservedBytes: number
  limitBytes: number
  remainingBytes: number
  usageRate: number
  state: 'normal' | 'notice' | 'warning' | 'full'
}

export type MediaUploadSession = {
  id: string
  filename: string
  sizeBytes: number
  targetMediaId: string | null
  method: 'PUT'
  /** 15分で失効するため、画面や履歴へ保存しない。 */
  uploadUrl: string
  requiredHeaders: Record<string, string>
  expiresAt: string
}

export type MediaUploadCompletion = {
  uploadSessionId: string
  status: 'verified' | 'completed'
  mediaId?: string | null
  targetMediaId?: string | null
}

export type FileScanStatus = 'pending' | 'clean' | 'rejected' | 'quarantined'

export type FileScanItem = {
  id: string
  confirmationRevision?: number
  lineAccountId: string | null
  subjectKind: string
  subjectId: string
  mediaId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  status: FileScanStatus
  reasonCode: string | null
  reasonLabel: string | null
  /** 一覧の時だけ付く。上げた人の表示。 */
  uploaderLabel?: string | null
  attempts: number
  nextRetryAt: string | null
  scannedAt: string | null
  quarantinedAt: string | null
  releasedAt: string | null
  releaseReason: string | null
  createdAt: string
  updatedAt: string
}

export type FileScanConfig = {
  confirmationRevision?: number
  externalProvider: string | null
  externalEndpointUrl: string | null
  externalSecretRef: string | null
  /** 現在の運営の許可設定で送信できるか。鍵の実在・疎通確認ではない。 */
  externalEnabled: boolean
  externalTimeoutMs: number
  maxBytesOverride: number | null
  maxPixelsOverride: number | null
  updatedAt: string
}

export type MediaVersionMetadata = {
  width: number | null
  height: number | null
  duration_ms: number | null
  page_count: number | null
  codec: string | null
}

export type MediaVersionBlocker =
  | 'different_kind'
  | 'upload_not_verified'
  | 'metadata_missing'
  | 'incompatible_dimensions'
  | 'incompatible_duration'
  | 'incompatible_pages'
  | 'incompatible_codec'

export type MediaVersionPreview = {
  mediaId: string
  uploadSessionId: string
  currentVersionNo: number
  previewToken: string
  blockers: MediaVersionBlocker[]
  canReplace: boolean
  currentMetadata?: MediaVersionMetadata
  incomingMetadata?: MediaVersionMetadata
}

export type MediaVersionResult = {
  id: string
  mediaId: string
  versionNo: number
  mimeType: string
  sizeBytes: number
  changeReason: string
  createdAt: string
}
