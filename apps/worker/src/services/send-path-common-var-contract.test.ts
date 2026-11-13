import { implementationFiles, readImplementationSource } from '../test-utils/implementation-source.js';
/*
 *  機械照合: LINE送信へ繋がる全経路が、共通情報を厳格resolver
 * （resolveSendInterpolationExtra / resolveSendCommonVars）経由で解決する
 * ことをソース走査で固定する。
 *
 * 空文字へ落ちる従来口（getCommonVarMap / 素の resolveInterpolationExtra）を
 * 送信経路へ新しく足すと、この試験が落ちる。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  const entries = new Set([...SEND_PATHS, ...NON_TEMPLATE_PATHS, { file: 'routes/chats.ts' }, { file: 'services/scheduled-chat-sends.ts' }, { file: 'services/reminder-draft.ts' }].map(p => join(SRC, p.file)));
  return readImplementationSource(join(SRC, rel), entries);
}

// LINE送信に繋がる経路と、そこで必須の厳格resolver呼び出し。
const SEND_PATHS: Array<{ file: string; mustCall: string; label: string }> = [
  { file: 'services/restaurant-followup-test-send.ts', mustCall: 'buildReminderStepMessage', label: '来店フォローの自分向けテスト送信' },
  {file:'features/hq-broadcasts/hq-broadcast-details.ts',mustCall:'resolveSendCommonVars',label:'統括の一括配信のテスト送信'},
  {file:'features/auto-replies/auto-reply-unmatched.ts',mustCall:'expandSendCommonVars',label:'LINEのキーワード未一致時の返事'},
  { file: 'services/step-delivery.ts', mustCall: 'resolveSendInterpolationExtra', label: 'シナリオ配信' },
  { file: 'services/immediate-first-step.ts', mustCall: 'resolveSendInterpolationExtra', label: '初回配信' },
  { file: 'services/reminder-delivery.ts', mustCall: 'resolveSendInterpolationExtra', label: 'リマインド' },
  { file: 'features/scenarios/scenario-test-send.ts', mustCall: 'resolveSendInterpolationExtra', label: 'シナリオテスト送信' },
  { file: 'services/manual-send-interpolation.ts', mustCall: 'resolveSendCommonVars', label: '個別送信・送信予約' },
  { file: 'features/broadcasts/broadcast.ts', mustCall: 'broadcastWideContext', label: '一斉配信の共通情報への接続' },
  { file: 'features/broadcasts/broadcast-wide-context.ts', mustCall: 'resolveSendCommonVars', label: '一斉配信（snapshot未到達の予備経路）' },
  { file: 'services/dedup-broadcast.ts', mustCall: 'resolveSendCommonVars', label: '複数アカウント重複排除配信' },
  { file: 'features/auto-replies/auto-reply.ts', mustCall: 'resolveSendInterpolationExtra', label: '自動応答の実送信' },
  { file: 'routes/forms.ts', mustCall: 'resolveSendInterpolationExtra', label: 'フォーム回答の自動返信' },
  { file: 'routes/broadcasts.ts', mustCall: 'resolveSendCommonVars', label: '一斉配信のテスト送信' },
  { file: 'features/automations/automation-action-handlers.ts', mustCall: 'expandSendCommonVars', label: 'オートメーションの送信アクション' },
  { file: 'services/event-bus.ts', mustCall: 'expandSendCommonVars', label: '旧イベント連携の送信アクション' },
  { file: 'features/rich-menus/rich-menu-tap.ts', mustCall: 'expandSendCommonVars', label: 'リッチメニューのテンプレート送信' },
  { file: 'features/forms/form-layout-effects.ts', mustCall: 'expandSendCommonVars', label: 'フォーム演出の送信' },
  { file: 'features/scenarios/scenario-question-answer.ts', mustCall: 'expandSendCommonVars', label: '質問カードの返信' },
  { file: 'services/carousel-tap.ts', mustCall: 'expandSendCommonVars', label: 'カルーセル制限時の返信' },
  { file: 'routes/liff.ts', mustCall: 'expandSendCommonVars', label: 'LIFFの案内テンプレート送信' },
  { file: 'routes/friends.ts', mustCall: 'expandSendCommonVars', label: '友だち詳細からの直接送信' },
  { file: 'routes/friend-add-rules.ts', mustCall: 'expandSendCommonVars', label: '友だち追加時の配信のテスト送信' },
  { file: 'routes/webhook.ts', mustCall: 'expandSendCommonVars', label: '流入リンク案内・追加クーポン' },
  { file: 'features/ec-commerce/ec-event-processing.ts', mustCall: 'expandSendCommonVars', label: 'ECイベント通知' },
  { file: 'routes/ec-commerce.ts', mustCall: 'expandSendCommonVars', label: 'EC通知のテスト送信' },
  { file: 'services/operator-notification-dispatch.ts', mustCall: 'expandSendCommonVars', label: '運用者向けLINE通知' },
  { file: 'features/broadcasts/broadcast-ab-live.ts', mustCall: 'resolveSendCommonVars', label: 'A/B本送信の試し' },
];

/*
 * LINE送信呼出しを持つが、運用者が書いた本文を使わない経路。
 * システム生成の固定文（通知・集計レポート）や、友だち名・案件名のような
 * データ差し込みだけの文はこちら。友だちの表示名などが "{{var.x}}" を
 * 含んでも展開しないのが正しい（展開すると別データ経由で共通情報の値が
 * 漏れうる）。この一覧は新規のLINE送信経路を足したとき必ず見直す。
 */
const NON_TEMPLATE_PATHS: Array<{ file: string; label: string }> = [
  {file:'features/auto-replies/auto-reply-delivery.ts',label:'遅延返信（auto-reply.tsで厳格に差し込み済みのJSONを固定して送る）'},
  { file: 'services/affiliate-notifier.ts', label: 'アフィリエイト通知（固定文）' },
  { file: 'services/analytics-reports.ts', label: '集計レポート通知（固定文）' },
  { file: 'features/booking/booking-notifier.ts', label: '予約通知（固定文）' },
  { file: 'services/event-booking-notifier.ts', label: 'イベント予約通知（固定文）' },
  { file: 'services/operation-notifications.ts', label: '運用アラート通知（固定文）' },
  { file: 'services/operation-alert-notifications.ts', label: '運用アラートのスタッフ通知（固定文）' },
  { file: 'routes/meet-callback.ts', label: 'Meet結果通知（固定文）' },
  { file: 'routes/line-notifications.ts', label: '通知の再試行（描画済みペイロードの再送）' },
  { file: 'services/platform-announcements.ts', label: '運営からのお知らせ（★V6 37-7。契約先の権限者宛て。友だち向けの共通情報は展開しない）' },
  // 予約重複の自動通知は運用者本文を使わず、固定文へ staffName だけ差し込む。
  // staffName が {{var.x}} を含んでも展開しない（別データ経由の共通情報漏れを防ぐ）。自動通知に manual は付けない。
  { file: 'features/booking/booking-channels.ts', label: '予約重複の自動通知（固定文。staffName のみ差し込み）' },
];

// LINE API への実送信を示す呼出しパターン。
// WithRequestId 形も含める（含めないとその経路だけ分類を強制できない）。
const LINE_SEND_PATTERN =
  /\.(pushMessage|replyMessage|multicast|broadcast|narrowcast)(WithRequestId)?\s*\(/;

describe('全送信経路が共通情報の厳格resolverを通る(N-189)', () => {
  for (const { file, mustCall, label } of SEND_PATHS) {
    it(`${label}（${file}）は ${mustCall} を使う`, () => {
      const source = read(file);
      expect(source).toContain(mustCall);
    });
  }

  it('空文字へ落ちる getCommonVarMap は送信経路から排除する', () => {
    for (const { file, label } of SEND_PATHS) {
      const source = read(file);
      expect(source, `${file} (${label}) が getCommonVarMap を直接呼んでいる`).not.toContain('getCommonVarMap');
    }
  });

  it('個別送信の呼出元はsource（台帳の出所）を必ず渡す', () => {
    for (const file of ['routes/chats.ts', 'services/scheduled-chat-sends.ts']) {
      const source = read(file);
      const calls = source.match(/renderChatMessageContent\([\s\S]*?\);/g) ?? [];
      const lenientPreviews = source.match(/lenient[\s\S]*?renderChatMessageContent\([\s\S]*?\);/g) ?? [];
      const sendCalls = calls.filter(
        (call) => !lenientPreviews.some((preview) => preview.endsWith(call)),
      );
      expect(sendCalls.length, `${file} に送信経路の呼出しがありません`).toBeGreaterThan(0);
      for (const call of sendCalls) {
        expect(
          /kind:\s*'chat'/.test(call),
          `${file} の renderChatMessageContent 呼出しに source がありません: ${call.slice(0, 120)}`,
        ).toBe(true);
      }
    }
  });

  it('自動応答の実送信では source を渡し、dry-run では渡さない', () => {
    // 実送信（matchAndReply内の呼出し）は source 付きで呼ぶ
    // dry-run（auto-replies.ts のプレビュー呼出し）は source なしのまま
    const dryRun = read('routes/auto-replies.ts');
    const previewCalls = dryRun.match(/previewAutoReplyContent\([^)]*\)/g) ?? [];
    for (const call of previewCalls) {
      expect(call).not.toContain('kind:');
    }
  });

  it('LINE送信を持つファイルは「厳格resolver経路」か「固定文経路」のどちらかに分類されている', () => {
    // LINE送信呼出しを持つファイルを全走査し、どちらの一覧にも無い
    // ファイルがあれば落とす。新しい送信経路を足したとき、ここで
    // 「厳格化するか・固定文と宣言するか」の判断を強制する。
    const sendFiles = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== 'node_modules') walk(full);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
          if (LINE_SEND_PATTERN.test(readFileSync(full, 'utf8'))) {
            sendFiles.add(full.slice(SRC.length + 1));
          }
        }
      }
    };
    walk(SRC);

    const strict = new Set(SEND_PATHS.map((p) => p.file));
    strict.add('routes/chats.ts');
    strict.add('services/scheduled-chat-sends.ts');
    // テスト送信は buildReminderStepMessage（厳格化済み）が組み立てた本文を送る。
    strict.add('services/reminder-draft.ts');
    const nonTemplate = new Set(NON_TEMPLATE_PATHS.map((p) => p.file));

    // 既存の監査済み入口を保ち、分割した実装は本物の import だけからたどる。未登録の送信処理も引き続き拒む。
    const audited = new Set([...strict, ...nonTemplate].map(file => join(SRC, file)));
    const owner = new Map<string, string>();
    for (const root of [...strict, ...nonTemplate]) {
      for (const file of implementationFiles(join(SRC, root), audited)) {
        const relative = file.slice(SRC.length + 1);
        const previous = owner.get(relative);
        if (previous && previous !== root) throw new Error(`Ambiguous sending module: ${relative}`);
        owner.set(relative, root);
      }
    }
    const logicalSendFiles = new Set([...sendFiles].map(file => owner.get(file) ?? file));
    for (const file of logicalSendFiles) {
      expect(
        strict.has(file) || nonTemplate.has(file),
        `${file} はLINE送信を持ちますが、厳格resolver経路・固定文経路のどちらにも分類されていません`,
      ).toBe(true);
    }
    // 固定文経路の陳腐化も防ぐ: 宣言したが送信呼出しが消えたファイルは落とす
    for (const file of nonTemplate) {
      expect(
        logicalSendFiles.has(file),
        `${file} は固定文経路として宣言されていますが、LINE送信呼出しが見つかりません`,
      ).toBe(true);
    }
  });
});
