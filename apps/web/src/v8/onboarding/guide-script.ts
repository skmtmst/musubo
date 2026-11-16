/*
  開店準備ガイドの台本。承認済み Pen
  /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 14 (orKSi) の進行表と、各手順の枠（04-1 dQfu4 / 04-2 SZBsN / 04-3 n7yEY /
  05-1 k6VII / 05-2 S3krL / 06-1 F32DI / 06-2 snX33 / 06-3 v21sow /
  07-1 j22Yem / 07-2 O5guw / 08 Xp7M0）の吹き出し本文をそのまま持つ。

  **文面はPenの承認済みの語をそのまま置く。** ここで言い換えない。
  ①LINE接続・②初期セット・③選ぶ・⑨1通 は枠14で既存画面やサーバーの出来事に
  委ねる段で、吹き出しの枠が無い。台本を作らず、案内は帯と行き先だけに留める。
*/

/** 進むきっかけ。枠14「次へ進むトリガー／種類」の対応。 */
export type GuideProcedureTrigger =
  /** 対象を押した時（クリック） */
  | 'click'
  /** 必須入力がそろった時（入力有効）。押さずに次の手順へ移る。 */
  | 'valid'
  /** 保存や接続の成功イベント */
  | 'event'

export type GuideProcedure = {
  /** 1から数える手順番号。吹き出しの札「手順 1/3」に出す。 */
  index: number
  title: string
  body: string
  /**
   * スポットライトを当てる対象の `data-guide-anchor` の値。
   * null は対象を光らせない手順（枠 04-3 n7yEY はスポットライト無し）。
   */
  anchor: string | null
  trigger: GuideProcedureTrigger
}

export type GuideStepScript = { stepKey: string; procedures: readonly GuideProcedure[] }

const SCRIPT: readonly GuideStepScript[] = [
  {
    // ④ 卓と席を登録する（枠14 HTwnu / F8mSog / viNtD）
    stepKey: 'attributes',
    procedures: [
      {
        index: 1,
        title: 'まず卓を作りましょう',
        body: '「+ 卓を作る」を押すと、卓の名前と席数を入れるフォームが開きます。作った卓はフロア図と右の一覧に並び、予約枠の計算に使われます。',
        anchor: 'tables.create',
        trigger: 'click',
      },
      {
        index: 2,
        title: '名前と席数を入れて保存',
        body: '卓の名前（例: テーブルA・カウンター）と席数を入れましょう。2つとも入ると、案内は自動で「保存する」に移ります。保存すると1卓目が登録され、手順3/3へ進みます。',
        anchor: 'tables.form',
        trigger: 'event',
      },
      {
        index: 3,
        title: '必要な卓をぜんぶ追加',
        body: 'カウンターや個室があれば「+ 卓を作る」で同じように追加します。追加を終えると右下に完了のお知らせが出るので、「次へ進む」で⑤営業時間へ。',
        anchor: null,
        trigger: 'click',
      },
    ],
  },
  {
    // ⑤ 営業時間（枠14 Nm43L / kYvXk）
    stepKey: 'hours',
    procedures: [
      {
        index: 1,
        title: 'Googleアカウントとつなぎましょう',
        body: 'お店のGoogleアカウントでログインして許可するだけ。戻ってくると営業時間が取り込まれ、ガイドが自動で再開します。',
        anchor: 'hours.googleConnect',
        /*
          押した時ではなく、認可画面から戻ってつながった時に進める（差し戻し R4）。
          失敗・中断で戻った時は 1/2 に留まる。合図は設定 › SNS連携の画面が出す。
        */
        trigger: 'event',
      },
      {
        index: 2,
        title: '営業時間を確認して確定',
        body: 'Googleから取り込んだ時間を確かめて「この営業時間で確定」。違うときは、先にGoogleビジネスで営業時間を直してから「Googleから再読み込み」を押してください。確定するとこの時間をもとに予約枠が自動で作られます。',
        anchor: 'hours.confirm',
        trigger: 'event',
      },
    ],
  },
  {
    // ⑥ コース（枠14 sIFft / KI5X0 / hYTr8）
    stepKey: 'friendAdd',
    procedures: [
      {
        index: 1,
        title: 'まずコースを作りましょう',
        body: '「+ メニューを作る」から作成画面が開きます。名前・値段・所要時間を入れるだけでOK。写真はあとからでも追加できます。',
        anchor: 'menu.create',
        trigger: 'click',
      },
      {
        index: 2,
        title: '基本を入力',
        body: '必須の3つ（名前・値段・所要時間）を入れましょう。3つとも入ると、ガイドは自動で次の手順（保存）に進みます。写真は任意 — あとからでも追加できます。',
        anchor: 'menu.form',
        trigger: 'valid',
      },
      {
        index: 3,
        title: '保存して完了',
        body: '必須3つが入ったので、あとは「保存する」だけ。保存するとコースが登録され、LINEの予約ページに表示されます。写真の追加・編集はあとからいつでもできます。',
        anchor: 'menu.save',
        trigger: 'event',
      },
    ],
  },
  {
    // ⑦ 予約枠（枠14 zvzk4 / t8xvM）
    stepKey: 'scenario',
    procedures: [
      {
        index: 1,
        title: 'LINEで受ける席数を入れる',
        body: '総数12席はお店の卓から自動で出ています。LINEで受けたい席数を入れるだけ — 残りは電話・店頭用に自動で取り置かれます。予約サイトや当日枠の細かい配分は、あとから必要になったときで大丈夫です。',
        anchor: 'reception.lineSeats',
        trigger: 'valid',
      },
      {
        index: 2,
        title: '保存して受け付けを始める',
        body: 'LINEの席数を確認して保存すると、LINE予約の受け付けが始まり、続けてリッチメニュー公開のご案内が表示されます。日別の細かい調整はこの画面でいつでもできます。',
        anchor: 'reception.save',
        trigger: 'event',
      },
    ],
  },
  {
    // ⑧ 来店フォロー（枠14 wcvyI）
    stepKey: 'followup',
    procedures: [
      {
        index: 1,
        title: '内容を確認して保存',
        body: 'おすすめの2つ（予約したとき・前日の確認）は最初からオンにしてあります。このまま「保存して作る」を押せば完了 — 保存と同時に配信の予定として登録され、予約が入ると自動で送られます。お礼や口コミはあとからいつでもオンにできます。',
        anchor: 'followup.save',
        trigger: 'event',
      },
    ],
  },
]

/** その段の手順の数。台本が無い段は0（吹き出しを出さない）。 */
export function guideProcedureTotal(stepKey: string | null): number {
  return SCRIPT.find(step => step.stepKey === stepKey)?.procedures.length ?? 0
}

/** いま出す手順。台本が無い段・範囲外の番号では null（勝手に別の手順を見せない）。 */
export function guideProcedure(stepKey: string | null, index: number): GuideProcedure | null {
  const step = SCRIPT.find(item => item.stepKey === stepKey)
  return step?.procedures.find(procedure => procedure.index === index) ?? null
}

/** 対象の `data-guide-anchor` に付ける印。画面側はこれを広げて使う。 */
export function guideAnchorAttribute(name: string): { 'data-guide-anchor': string } {
  return { 'data-guide-anchor': name }
}
