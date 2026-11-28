import { describe, expect, it } from 'vitest';
import {
  addTestLabel,
  buildMessages,
  combinedMessageContent,
  hasRecipientVariablesInParts,
  parseBroadcastMessageParts,
  renderMessageParts,
  unsupportedMessageVariables,
  varyTextMessages,
} from './broadcast-message-set.js';

const bubbles = [
  { id: '1', type: 'text', content: { text: 'こんにちは {{name}}' } },
  { id: '2', type: 'image', content: { originalContentUrl: 'https://e.test/a.jpg', previewImageUrl: 'https://e.test/p.jpg' } },
  { id: '3', type: 'location', content: { state: { location: { title: '本店', address: '東京', latitude: '35.6', longitude: '139.7' } } } },
  { id: '4', type: 'audio', content: { state: { audio: { originalContentUrl: 'https://e.test/a.m4a', duration: '12' } } } },
  { id: '5', type: 'sticker', content: { state: { sticker: { packageId: '446', stickerId: '1988' } } } },
];

describe('一斉配信の複数吹き出し契約', () => {
  it('既存の1通は配列1件として扱う', () => {
    expect(parseBroadcastMessageParts({ messageType: 'text', messageContent: '本文' })).toEqual([
      { id: 'legacy-1', messageType: 'text', messageContent: '本文', altText: undefined },
    ]);
  });

  it('1〜5通を画面の保存形式からLINEの形式へ変換する', () => {
    const parts = parseBroadcastMessageParts({ messageType: 'text', messageContent: 'legacy', messageBubbles: bubbles });
    expect(parts).toHaveLength(5);
    expect(buildMessages(parts).map((message) => message.type)).toEqual([
      'text', 'image', 'location', 'audio', 'sticker',
    ]);
    expect(parts[3].messageContent).toContain('12000');
  });

  it('6通・未対応種別・壊れた中身を送信前に止める', () => {
    expect(() => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [...bubbles, bubbles[0]] }))
      .toThrow('1 to 5');
    expect(() => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [{ type: 'unknown_type', content: {} }] }))
      .toThrow('Unsupported');
    expect(() => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [{ type: 'image', content: {} }] }))
      .toThrow('画像のファイルをアップロードしてください');
  });

  it('動画・画像はプレビュー画像まで https で揃っていないと人の言葉で止める（2026-10-07 点検）', () => {
    const parse = (type: string, content: Record<string, unknown>) =>
      () => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [{ type, content }] });
    expect(parse('video', { originalContentUrl: 'https://e.test/v.mp4', previewImageUrl: '' }))
      .toThrow('動画のプレビュー画像のURLを入れてください');
    expect(parse('video', { originalContentUrl: 'https://e.test/v.mp4', previewImageUrl: 'http://e.test/p.jpg' }))
      .toThrow('動画のプレビュー画像のURLは https:// から始めてください');
    expect(parse('video', { originalContentUrl: 'http://e.test/v.mp4', previewImageUrl: 'https://e.test/p.jpg' }))
      .toThrow('動画のURLは https:// から始めてください');
    expect(parse('video', { originalContentUrl: 'https://e.test/v.mp4', previewImageUrl: 'https://e.test/p.jpg' })).not.toThrow();
  });

  it('範囲外の緯度・経度を直し方で止める（監査 R210）', () => {
    // 地図上に無い数字を完成扱いにすると、下書きに残って送られる。
    const outOfRange = (latitude: string, longitude: string) => ({
      type: 'location',
      content: { state: { location: { title: '本店', address: '東京', latitude, longitude } } },
    });
    expect(() => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [outOfRange('91', '139.7')] }))
      .toThrow('緯度は-90〜90');
    expect(() => parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [outOfRange('35.6', '181')] }))
      .toThrow('経度は-180〜180');
    // 境界値は通す。
    const parts = parseBroadcastMessageParts({ messageType: 'text', messageContent: 'x', messageBubbles: [outOfRange('90', '-180')] });
    expect(parts).toHaveLength(1);
  });

  it('配信用素材4種類を画面と同じ変換でLINEの種別に直す', () => {
    // 画面の保存（1吹き出し）と複数吹き出しの解析が同じ変換を使う。
    // 中身の JSON が本文にならない。
    const assetBubbles = [
      {
        id: 'c1', type: 'card_message',
        content: {
          assetId: 'a1', assetName: '夏の案内',
          cards: [{ title: 'パネル', description: '説明です', actionLabel: '詳しく見る', actionUrl: 'https://example.com/a' }],
          moreCard: false,
        },
      },
      {
        id: 'r1', type: 'rich_message',
        content: { assetId: 'a2', assetName: '便り',baseUrl:'https://example.com/images/map',baseSize:{width:1040,height:520},tapAreas:[{x:0,y:0,width:100,height:100,actionType:'uri',uri:'https://example.com/lp'}], imageUrl: 'https://example.com/a.png', description: '新米です', actionUrl: 'https://example.com/lp' },
      },
      {
        id: 'q1', type: 'coupon',
        content: { assetId: 'a3', assetName: '夏クーポン',startsAt:'2026-01-01T00:00',endsAt:'2027-01-01T00:00', description: '500円引き', actionUrl: 'https://example.com/c' },
      },
      {
        id: 's1', type: 'research',
        content: { assetId: 'a4', assetName: '調査', description: '答えてください', questions: [{ text: '質問', format: 'free', required: true }] },
      },
    ];
    const parts = parseBroadcastMessageParts({ messageType: 'text', messageContent: 'legacy', messageBubbles: assetBubbles });
    expect(parts.map((part) => part.messageType)).toEqual(['carousel', 'imagemap', 'flex', 'flex']);
    for (const part of parts) {
      expect(part.messageContent).not.toContain('assetId');
    }
    expect(parts[2].messageContent).toContain('coupon_use:a3');
    expect(buildMessages(parts).map((message) => message.type)).toEqual(['template', 'imagemap', 'flex', 'flex']);
  });

  it('直せない素材は直し方で止める', () => {
    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x',
      messageBubbles: [{ type: 'card_message', content: { assetId: 'a', assetName: '案内', cards: [{ title: 'パネル' }] } }],
    })).toThrow('リンク先');
  });

  it('全吹き出しをまとめて差し込み検査し、各通を相手ごとに描画する', () => {
    const parts = parseBroadcastMessageParts({
      messageType: 'text',
      messageContent: 'legacy',
      messageBubbles: [
        { type: 'text', content: { text: '{{name}}さん' } },
        { type: 'text', content: { text: '{{var.shop}} / {{unsupported}}' } },
      ],
    });
    expect(hasRecipientVariablesInParts(parts)).toBe(true);
    expect(unsupportedMessageVariables(parts)).toEqual(['unsupported']);
    expect(combinedMessageContent(parts)).toContain('{{var.shop}}');
    const rendered = renderMessageParts(parts.slice(0, 1), { displayName: '田中' });
    expect(rendered[0].messageContent).toBe('田中さん');
  });

  /*
   * 監査の不正例（音声 not-a-url・スタンプ not-a-package・Flex {}・
   * カルーセル [{}]）は、保存・配信前検査・送信のどこでも通さない。
   * 正常例（https・数字の番号・バブル・中身のあるパネル）は通す。
   */
  it('R234: 送れない音声URL・スタンプ番号・Flex・カルーセルを止める', () => {
    const audio = (url: string) => ({
      type: 'audio', content: { state: { audio: { originalContentUrl: url, duration: '1' } } },
    });
    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x', messageBubbles: [audio('not-a-url')],
    })).toThrow('https://');
    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x', messageBubbles: [audio('http://e.test/a.m4a')],
    })).toThrow('https://');
    // 正常例（https・1秒）は通す。短さでは止めない。
    const okAudio = parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x', messageBubbles: [audio('https://e.test/a.m4a')],
    });
    expect(okAudio[0].messageContent).toContain('1000');

    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x',
      messageBubbles: [{ type: 'sticker', content: { state: { sticker: { packageId: 'not-a-package', stickerId: 'not-a-sticker' } } } }],
    })).toThrow('番号');

    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x',
      messageBubbles: [{ type: 'flex', content: { flexJson: '{}' } }],
    })).toThrow('バブルかカルーセル');

    expect(() => parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'x',
      messageBubbles: [{ type: 'carousel', content: { columnsJson: '[{}]' } }],
    })).toThrow('空のパネル');
  });

  it('テスト表示とバッチ差分は先頭のテキストだけへ付ける', () => {
    const parts = parseBroadcastMessageParts({
      messageType: 'text', messageContent: 'legacy',
      messageBubbles: [
        { type: 'image', content: { originalContentUrl: 'https://e.test/a.jpg', previewImageUrl: 'https://e.test/p.jpg' } },
        { type: 'text', content: { text: '一通目' } },
        { type: 'text', content: { text: '二通目' } },
      ],
    });
    const labelled = addTestLabel(parts);
    expect(labelled[1].messageContent).toContain('【テスト配信】');
    expect(labelled[2].messageContent).toBe('二通目');
    const varied = varyTextMessages(buildMessages(labelled), 1, 2);
    expect(varied).toHaveLength(3);
    expect(varied[2]).toEqual(buildMessages(labelled)[2]);
  });
});

it('追加ボタンの送信 JSON は URI と postback の順序・値を保つ', () => {
  const parts = parseBroadcastMessageParts({ messageType: 'text', messageContent: '本文', messageOptions: { buttons: [
    { type: 'url', label: '詳細', value: 'https://example.com/a' },
    { type: 'postback', label: '返事', value: 'reply=1' },
  ] } });
  expect(parts[1]).toMatchObject({ id: 'message-buttons', messageType: 'flex', altText: 'ボタン' });
  expect(parts[1].messageContent).toBe('{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"button","action":{"type":"uri","label":"詳細","uri":"https://example.com/a"}},{"type":"button","action":{"type":"postback","label":"返事","data":"reply=1"}}]}}');
});
