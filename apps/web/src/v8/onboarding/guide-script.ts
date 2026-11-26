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
  /** 内容を確認してガイドの「次へ」を押す。 */
  | 'confirm-input'
  /** 保存や接続の成功イベント */
  | 'event'

export type GuideProcedure = {
  /** 1から数える手順番号。吹き出しの札「手順 1/3」に出す。 */
  index: number
  title: string
  body: string
  mobileBody?: string
  /**
   * スポットライトを当てる対象の `data-guide-anchor` の値。
   * null は対象を光らせない手順（枠 04-3 n7yEY はスポットライト無し）。
   */
  anchor: string | null
  trigger: GuideProcedureTrigger
  /**
   * この手順の対象がある画面。段の行き先と違う手順だけ書く。
   * 書いた手順では、別の画面にいる間に案内がこの画面へ連れていく。
   * 省略時は段の行き先（9項目の行のリンク先）をその手順の画面として扱う。
   */
  href?: string
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
        body: '「卓を作る」を押すと、卓番・表示名や席の条件を設定できます。作った卓はフロア図と右の一覧に並び、予約枠の計算に使われます。',
        anchor: 'tables.create',
        trigger: 'click',
      },
      {
        index: 2,
        title: '卓の情報を入れる',
        body: '卓番と表示名を入れ、人数と席の設定を確認します。',
        mobileBody: '必須項目を入れたら「卓を作る」を押します。',
        anchor: 'tables.form',
        trigger: 'event',
      },
      {
        index: 3,
        title: '必要な卓をぜんぶ追加',
        body: 'カウンターや個室も「卓を作る」で追加できます。必要な卓を登録したら「次へ進む」を押してください。',
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
        /* 接続の成功を確認してから、同じ営業時間タブの確認へ進む。 */
        trigger: 'event',
        href: '/restaurant-test/google?tab=hours',
      },
      {
        index: 2,
        title: '営業時間を確認して確定',
        body: '取り込んだ営業時間を確かめて「この営業時間で確定」を押します。違うときはGoogleビジネスで直してから「Googleから再読み込み」を押してください。確定すると最初の予約枠が作られます。',
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
        body: '「メニューを作る」から作成画面を開きます。名前・値段・所要時間を入力します。写真はあとから追加できます。',
        anchor: 'menu.create',
        trigger: 'click',
      },
      {
        index: 2,
        title: '保存する状態を確認する',
        body: '「下書き」はお客さまには表示されません。あとから公開できます。',
        anchor: 'menu.status',
        href: '/restaurant-test/menu/edit',
        trigger: 'confirm-input',
      },
      {
        index: 3,
        title: 'コースの名前を入れる',
        body: 'お客さまに表示する名前を入れてください。',
        anchor: 'menu.name',
        href: '/restaurant-test/menu/edit',
        trigger: 'confirm-input',
      },
      {
        index: 4,
        title: '1名の値段を入れる',
        body: '1名あたりの税込価格を、円単位の整数で入れてください。',
        anchor: 'menu.price',
        href: '/restaurant-test/menu/edit',
        trigger: 'confirm-input',
      },
      {
        index: 5,
        title: '所要時間を選ぶ',
        body: '席を使う時間を選んでください。30分刻みで選べます。',
        anchor: 'menu.duration',
        href: '/restaurant-test/menu/edit',
        trigger: 'confirm-input',
      },
      {
        index: 6,
        title: '保存して完了',
        body: '「保存して追加する」を押すと、次の設定へ進みます。',
        anchor: 'menu.save',
        href: '/restaurant-test/menu/edit',
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
        body: '1つの時間枠で、LINEから受ける席数を入れます。',
        anchor: 'reception.lineSeats',
        trigger: 'valid',
      },
      {
        index: 2,
        title: '配分を保存する',
        body: '保存すると、営業日の全時間帯に設定した席数を適用します。今後の営業日にも自動で適用します。',
        anchor: 'reception.save',
        trigger: 'event',
      },
    ],
  },
  {
    stepKey: 'followup',
    procedures: [
      {
        index: 1,
        title: '予約したときをオンにする',
        body: 'スイッチを押して、本文を確認します。',
        anchor: 'followup.start',
        trigger: 'event',
      },
      {
        index: 2,
        title: '送る時期と本文を確認する',
        body: 'いつ送るかと、お客さまに届く本文を確認してください。',
        mobileBody: 'いつ送るかと、本文を確認します。',
        anchor: 'followup.body',
        trigger: 'confirm-input',
      },
      {
        index: 3,
        title: 'この内容でオンにする',
        body: '確認した内容で送り方をオンにします。次の画面で保存します。',
        mobileBody: '確認した内容でオンにします。次に一覧で保存します。',
        anchor: 'followup.confirm',
        trigger: 'event',
      },
      {
        index: 4,
        title: '保存して作る',
        body: '「保存して作る」で下書きができます。メッセージの送信は、テスト送信と承認のあとに始めます。',
        mobileBody: 'この設定を保存すると、送り方の下書きができます。',
        anchor: 'followup.save',
        trigger: 'event',
      },
    ],
  },
]

export function receptionGuideCopy(mode: string | null, seatCount: string | null) {
  if (mode === 'hours') return {
    title: '営業時間を設定する',
    body: '営業時間を設定して戻ると、LINEで受ける席数を入力できます。',
  }
  if (mode === 'saving') return {
    title: '配分を保存しています',
    body: '保存できると、自動で次の手順へ進みます。',
  }
  if (mode === 'conflict') return {
    title: '最新の配分を確かめる',
    body: '入力した席数は残っています。最新の配分を確認してから保存してください。',
  }
  if (mode === 'retry') return {
    title: 'もう一度保存する',
    body: '入力した席数は残っています。「配分を保存する」をもう一度押してください。',
  }
  if (seatCount && Number(seatCount) > 0) return {
    title: '配分を保存する',
    body: `保存すると、営業日の全時間帯に${seatCount}席ずつ適用します。今後の営業日にも自動で適用します。`,
  }
  return null
}

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
