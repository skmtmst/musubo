/*
 *  結合送信口の公開契約（直接契約試験）。
 *
 * 実物のアプリへ GET /openapi.json を当て、POST
 * /api/chats/{id}/send-combined の記載が実装と食い違っていないことを
 * 直接確かめる。openapi-coverage の件数ゲートとは別に、中身（引数・
 * 応答コード）まで見る。
 */
import { describe, expect, test } from 'vitest';
import { app } from '../index.js';

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, { description?: string }>;
};

async function sendCombinedOperation(): Promise<Operation> {
  const res = await app.request('/openapi.json');
  expect(res.status).toBe(200);
  const spec = (await res.json()) as {
    paths?: Record<string, Record<string, Operation>>;
  };
  const operation = spec.paths?.['/api/chats/{id}/send-combined']?.post;
  expect(operation, '結合送信口が /openapi.json に載っていない').toBeDefined();
  return operation as Operation;
}

describe('画像と本文の結合送信の入力と応答を公開仕様に載せる', () => {
  test('path引数idと本文（画像・本文・版）を受け付ける', async () => {
    const operation = await sendCombinedOperation();
    expect(operation.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
    const schema = operation.requestBody?.content?.['application/json']?.schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(operation.requestBody?.required).toBe(true);
    expect(Object.keys(schema?.properties ?? {})).toEqual(
      expect.arrayContaining(['image', 'text', 'revision']),
    );
  });

  test('成功・入力不備・未発見・版食い違いの応答が載っている', async () => {
    const operation = await sendCombinedOperation();
    expect(Object.keys(operation.responses ?? {}).sort()).toEqual(['200', '400', '404', '409']);
  });
});
