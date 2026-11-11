/** 運営お問い合わせ画面を撮影するための固定データ。 */
export const OPS_SUPPORT_SUMMARY = {
  byStage: { all: 5, new: 2, in_progress: 3, waiting: 1, resolved: 12, closed: 40 },
  kpis: {
    untouched: 2, untouchedFromLine: 1,
    avgFirstReplyMinutes: 95, prevAvgFirstReplyMinutes: 120,
    resolutionRate: 80, prevResolutionRate: 75,
    avgResolutionMinutes: 300, prevAvgResolutionMinutes: 360,
  },
}

export const OPS_SUPPORT_TEMPLATE_CATALOG = {
  folders: [
    { id: 'contracts', name: '契約・解約' },
    { id: 'usage', name: '使い方・操作' },
    { id: 'billing', name: '請求・支払い' },
    { id: 'line', name: 'LINE連携・配信' },
    { id: 'incident', name: '不具合・障害' },
    { id: 'other', name: 'その他' },
  ],
  templates: [
    { id: 'visual-reply-cancel', folderId: 'contracts', title: '解約手続きのご案内', body: 'お問い合わせありがとうございます。\n\nご契約の解約をご希望とのこと、承知しました。担当者が内容を確認し、必要な手続きをご案内します。\n\nご不明な点があれば、このお問い合わせからお知らせください。', createdAt: '2026-09-01T10:00:00+09:00', updatedAt: '2026-09-01T10:00:00+09:00' },
    { id: 'visual-reply-refund', folderId: 'contracts', title: '返金に関するご案内', body: 'お問い合わせありがとうございます。返金条件と確認手順をご案内します。', createdAt: '2026-09-02T10:00:00+09:00', updatedAt: '2026-09-02T10:00:00+09:00' },
    { id: 'visual-reply-change', folderId: 'contracts', title: '契約内容の変更', body: 'お問い合わせありがとうございます。変更をご希望の内容を確認し、手続きをご案内します。', createdAt: '2026-09-03T10:00:00+09:00', updatedAt: '2026-09-03T10:00:00+09:00' },
  ],
}
