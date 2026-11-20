// 実行時の副作用を混ぜず定義だけを置き、ハンドラは各機能の経路に保つ。
export const formsPaths = {
  '/api/forms/{id}/common-var-pins/{varId}': {
    put: { tags: ['Forms'], summary: '次に公開する版で使う共通情報の固定を変更',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'varId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId','versionId','expectedVersion'], properties: { accountId: { type: 'string' }, versionId: { type: 'string', nullable: true }, expectedVersion: { type: 'integer', minimum: 1 } } } } } },
      responses: { '200': { description: '変更済み' }, '400': { description: '入力が不正' }, '404': { description: '使用先が見つからない' }, '409': { description: '使用先または版を確認できない' } },
    },
  },
  '/api/forms/{id}/images/{blockId}': {
    get: {
      tags: ['Forms'], summary: '公開中のフォームが採用した固定版の画像を表示', security: [],
      description: '現在の公開版・同店所属・画像所有・公開用途・検査・停止・期限・実体の版を毎回照合する。共有フォームは同店のLINE本人確認が必要。任意の画像IDや試し合言葉は権限にしない。応答はno-store。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'blockId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'formVersionId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { '200': { description: '採用した画像版の実体' }, '404': { description: '未採用・版違い・停止・隔離・所属不明を区別せず返す' }, '503': { description: '利用停止または一時的な取得障害' } },
    },
  },
  // ── Forms ────────────────────────────────────────────────────────────
  '/api/forms/unassigned': {
    get: {
      tags: ['Forms'],
      summary: '担当の決まっていない旧フォームだけを返す（管理者確認 #724）',
      parameters: [
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '未割り当てフォームの一覧' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: '権限範囲外（一般staff・制限付き・別テナント）' },
      },
    },
  },
  '/api/forms/{id}/submissions/{submissionId}': {
    delete: {
      tags: ['Forms'], summary: '個別の回答と添付を削除（B-215）',
      description: '書込可能なオーナー・管理者だけ。回答とアカウントの所属を照合し、R2・DB・完了監査を再試行可能に削除する。成功済みの再実行はreplayed=true。同時実行は409。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'submissionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'X-Confirm-Irreversible', in: 'header', required: true, schema: { type: 'string', enum: ['delete-form-response'] } },
      ],
      responses: {
        '200': { description: '削除完了または成功済みの再実行。data.deleted=true、data.replayedはboolean' },
        '403': { description: 'スタッフ・閲覧のみ・未認証は実行不可' },
        '404': { description: '対象が無いか、所属・フォーム・アカウントが範囲外' },
        '409': { description: 'deletion_in_progress または deletion_schema_approval_required（保存対象の保護にmigration承認が必要）' },
        '428': { description: '確認ヘッダーが無いか不一致' },
        '503': { description: 'deletion_retry_required。同じ対象で再試行する' },
      },
    },
    get: {
      tags: ['Forms'], summary: 'フォーム回答1件と後処理の済んだ工程を読み直す',
      description: '所有者・管理者・スタッフの閲覧範囲とフォームとの一致を確認する。試し回答は404。過去の工程で日時が不明ならcompletedAtはnull。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'submissionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': {
          description: '回答の詳細、書き込み結果、後処理の未完了・完了工程',
          content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'],
            properties: {
              success: { const: true },
              data: {
                type: 'object', required: ['id', 'formId', 'formVersionId', 'friendId', 'friendName', 'data', 'destinationWrite', 'postActions', 'createdAt'],
                properties: {
                  id: { type: 'string' }, formId: { type: 'string' }, formVersionId: { type: ['string', 'null'] },
                  friendId: { type: ['string', 'null'] }, friendName: { type: ['string', 'null'] },
                  data: { type: 'object', additionalProperties: true }, createdAt: { type: 'string' },
                  destinationWrite: {
                    type: 'object', required: ['status', 'attempted', 'succeeded', 'failed'],
                    properties: {
                      status: { type: 'string', enum: ['pending', 'succeeded', 'partial', 'failed', 'not_requested', 'unknown'] },
                      attempted: { type: ['integer', 'null'] }, succeeded: { type: ['integer', 'null'] }, failed: { type: ['integer', 'null'] },
                    },
                  },
                  postActions: {
                    type: ['object', 'null'], required: ['state', 'pending', 'completed'],
                    properties: {
                      state: { type: 'string', enum: ['completed', 'failed', 'in_progress', 'untracked'] },
                      pending: { type: 'array', items: { type: 'string' } },
                      completed: { type: 'array', items: {
                        type: 'object', required: ['step', 'completedAt'],
                        properties: { step: { type: 'string' }, completedAt: { type: ['string', 'null'] } },
                      } },
                    },
                  },
                },
              },
            },
          } } },
        },
        '401': { description: '認証が必要' },
        '403': { description: '所有者・管理者・スタッフの権限が必要' },
        '404': { description: 'フォーム・回答が無い、試し回答、または閲覧範囲外' },
        '500': { description: '回答の詳細を取得できない' },
      },
    },
  },
  '/api/forms/{id}/submissions/{submissionId}/retry-effects': {
    post: {
      tags: ['Forms'],
      summary: '完了しなかった回答の後処理だけを、予約(claim)の工程記録に沿って再実行する(N-168)',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'submissionId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '再実行結果。完了済みの回答は complete: true で返す' },
        '403': { description: 'Owner or admin role required' },
        '404': { description: 'フォーム・回答が無い、または権限範囲外' },
        '409': { description: '後処理の記録(claim)が無い回答' },
        '429': { description: '別の処理が進行中' },
      },
    },
  },
  '/api/forms/{id}/publish': {
    post: {
      tags: ['Forms'],
      summary: '保存済みのフォーム編集版を不変の公開版として公開',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['expectedContentRevision'],
              properties: { expectedContentRevision: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      responses: {
        '200': { description: '公開済み（同じ編集版の再実行を含む）' },
        '400': { description: '確認した編集版が不正' },
        '404': { description: 'フォームが無い、または権限範囲外' },
        '409': { description: '保存後に編集内容が変わった' },
      },
    },
  },
  '/api/forms/{id}/duplicate': {
    post: {
      tags: ['Forms'],
      summary: 'フォーム全体を別IDの下書きとして複製する',
      description: '質問・レイアウト・回答後の設定・所属フォルダ・利用アカウントを引き継ぐ。集まった回答・公開版・公開状態・集計は引き継がず、複製は必ず受付停止で作る。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: false, schema: { type: 'string' } },
      ],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { name: { type: 'string', description: '複製の名前。空なら「元の名前の複製」' } },
            },
          },
        },
      },
      responses: {
        '201': { description: '複製した下書き（受付停止）' },
        '403': { description: 'フォームの編集権限が無い' },
        '404': { description: 'フォームが無い、または権限範囲外' },
      },
    },
  },
  '/api/forms/{id}/unarchive': {
    post: {
      tags: ['Forms'],
      summary: '保管した回答フォームを元に戻す（戻した直後は受付停止のまま）',
      description: '保管中の行だけ現行へ戻す。確認した版（expectedRevision）がずれたら409で読み直しを促す。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['expectedRevision'], properties: { expectedRevision: { type: 'number' } } } } } },
      responses: {
        '200': { description: '現行へ戻した（status, revision, isActive）' },
        '400': { description: '確認した版が必要' },
        '403': { description: 'フォームの編集権限が無い' },
        '404': { description: 'フォームが無い、または権限範囲外' },
        '409': { description: '保管されていない、または版が変わった' },
      },
    },
  },
  '/api/forms/{id}/test-token': {
    post: {
      tags: ['Forms'],
      summary: '公開前の試し開き・試し回答に使う合言葉を発行する',
      description: '生の合言葉はこの応答でしか返さない。台帳にはSHA-256の16進だけを残し、有効期限は24時間。試し回答は集計に入れず、回答後アクションも動かさない。',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'account_id', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: '合言葉と有効期限（token, expiresAt）' },
        '403': { description: 'フォームの編集権限が無い' },
        '404': { description: 'フォームが無い、または権限範囲外' },
        '429': { description: '試し合言葉が上限（5件）に達している' },
      },
    },
  },
};
