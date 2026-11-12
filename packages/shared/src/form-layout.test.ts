import { describe, expect, test } from "vitest";
import { collectInputs, emptyLayout, fieldsToLayout, formChoiceIsSelected, formThemeButtonText, FORM_THEME_DEFAULT, formThemeContrastError, isCalendarDateString, isFormAnswerEmpty, layoutToFields, newBlockId, nextSectionIndex, normalizeLayout, normalizeFormTheme, parseLayout, validateAnswer, validateAnswers, validateFormDefinition, validateFormForPublish } from './form-layout';
import { type FormBlock, type FormInputBlock, type FormLayout } from './types/form-layout';

/** 入力ブロックを1つ作る。テストの見通しのため、必要な分だけ埋める。 */
function input(partial: Partial<FormInputBlock> & { name: string }): FormInputBlock {
  return {
    id: newBlockId(),
    kind: "input",
    type: "text",
    label: partial.name,
    ...partial,
  };
}

function layoutWith(blocks: FormInputBlock[]): FormLayout {
  const layout = emptyLayout();
  layout.sections[0].blocks = blocks;
  return layout;
}

describe("昔の fields から持ち上げる", () => {
  test("type ごとに、単一行＋入力制限へ寄せる", () => {
    const layout = fieldsToLayout([
      { name: "mail", label: "メール", type: "email", required: true },
      { name: "tel", label: "電話", type: "tel" },
      { name: "age", label: "年齢", type: "number" },
    ]);

    const inputs = collectInputs(layout);
    expect(inputs.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(inputs.map((b) => b.limit?.format)).toEqual(["email", "tel", "integer"]);
    expect(inputs[0].required).toBe(true);
  });

  test("見出しは入力欄にならない", () => {
    const layout = fieldsToLayout([
      { name: "h", label: "基本情報", type: "heading" },
      { name: "x", label: "お名前", type: "text" },
    ]);
    expect(layout.sections[0].blocks[0].kind).toBe("heading");
    expect(collectInputs(layout)).toHaveLength(1);
  });

  test("登録先とオプションを引き継ぐ", () => {
    const layout = fieldsToLayout([
      { name: "x", label: "お名前", type: "text", friendFieldId: "ff-1" },
      { name: "y", label: "好み", type: "select", options: ["犬", "猫"] },
    ]);
    const [first, second] = collectInputs(layout);
    expect(first.destinations?.friendFieldIds).toEqual(["ff-1"]);
    expect(second.choices?.map((c) => c.label)).toEqual(["犬", "猫"]);
  });
});

describe("互換の fields を作り直す", () => {
  test("入力欄だけを、出る順に並べる", () => {
    const layout = emptyLayout();
    layout.header = [
      { id: "b1", kind: "text", text: "ごあいさつ" },
      input({ name: "from_header", label: "紹介コード" }),
    ];
    layout.sections[0].blocks = [
      { id: "b2", kind: "heading", text: "基本情報", level: 2 },
      input({ name: "full_name", label: "お名前", required: true }),
    ];

    expect(layoutToFields(layout)).toEqual([
      { name: "from_header", label: "紹介コード", type: "text", required: false },
      { name: "full_name", label: "お名前", type: "text", required: true },
    ]);
  });

  test("入力制限は昔の type 名へ寄せる", () => {
    const layout = layoutWith([
      input({ name: "mail", label: "メール", limit: { format: "email" } }),
      input({ name: "pref", label: "住まい", type: "prefecture" }),
    ]);
    expect(layoutToFields(layout).map((f) => f.type)).toEqual(["email", "select"]);
  });

  test("選択肢はラベルの配列になる", () => {
    const layout = layoutWith([
      input({
        name: "plan",
        label: "プラン",
        type: "radio",
        choices: [
          { id: "c1", label: "松", tagId: "t1" },
          { id: "c2", label: "竹", tagId: "t2" },
        ],
      }),
    ]);
    expect(layoutToFields(layout)[0].options).toEqual(["松", "竹"]);
  });
});

describe("壊れた入力を受け止める", () => {
  test("読めない JSON は fields から作り直す", () => {
    const layout = parseLayout("{壊れている", JSON.stringify([{ name: "x", label: "名前" }]));
    expect(collectInputs(layout).map((b) => b.name)).toEqual(["x"]);
  });

  test("layout も fields も無ければ、空のフォームになる", () => {
    const layout = parseLayout(null);
    expect(layout.sections).toHaveLength(1);
    expect(layout.sections[0].blocks).toHaveLength(0);
  });

  test("セクションが無い JSON でも、1枚に整える", () => {
    const layout = normalizeLayout({ version: 2, header: [], sections: [], options: {} });
    expect(layout?.sections).toHaveLength(1);
  });

  test("知らない種類のブロックは正規化前に拒否する", () => {
    const layout = normalizeLayout({
      sections: [{ id: "s1", name: "1", blocks: [{ id: "x", kind: "iframe", src: "..." }] }],
    });
    expect(layout).toBeNull();
  });
});

describe("回答の検証", () => {
  test("必須が空なら断る", () => {
    const block = input({ name: "x", label: "お名前", required: true });
    expect(validateAnswer(block, "")).toBe("お名前 は必須項目です");
    expect(validateAnswer(block, "山田")).toBeNull();
  });

  test("必須でなければ、空欄は通す", () => {
    const block = input({ name: "x", label: "メモ", limit: { format: "email" } });
    expect(validateAnswer(block, "")).toBeNull();
  });

  test("形式ごとの判定", () => {
    const cases: [string, string, boolean][] = [
      ["email", "a@example.com", true],
      ["email", "a@example", false],
      ["kana", "ヤマダタロウ", true],
      ["kana", "やまだ", false],
      ["tel", "09000005678", true],
      ["tel", "090-0000-5678", true],
      ["tel", "電話", false],
      ["integer", "42", true],
      ["integer", "4.2", false],
      ["zip", "123-4567", true],
      ["zip", "1234567", true],
      ["zip", "12-34", false],
      ["time", "9:00", true],
      ["time", "25:00", false],
    ];
    for (const [format, value, ok] of cases) {
      const block = input({
        name: "x",
        label: "欄",
        limit: { format: format as never },
      });
      expect(validateAnswer(block, value) === null, `${format}: ${value}`).toBe(ok);
    }
  });

  test("文字数の上下限", () => {
    const block = input({ name: "x", label: "紹介文", limit: { min: 3, max: 5 } });
    expect(validateAnswer(block, "あい")).toBe("紹介文 は3文字以上で入力してください");
    expect(validateAnswer(block, "あいうえおか")).toBe("紹介文 は5文字までです");
    expect(validateAnswer(block, "あいうえ")).toBeNull();
  });

  test("チェックボックスの選択数", () => {
    const block = input({
      name: "x",
      label: "気になる機能",
      type: "checkbox",
      choices: [
        { id: "c1", label: "配信" },
        { id: "c2", label: "フォーム" },
        { id: "c3", label: "タグ" },
      ],
      selectionLimit: { min: 2, max: 2 },
    });
    expect(validateAnswer(block, ["配信"])).toBe("気になる機能 は2つ以上選んでください");
    expect(validateAnswer(block, ["配信", "フォーム", "タグ"])).toBe(
      "気になる機能 は2つまで選べます",
    );
    expect(validateAnswer(block, ["配信", "タグ"])).toBeNull();
  });

  test("用意していない選択肢は断る。ただし「その他」があるときは通す", () => {
    const strict = input({
      name: "x",
      label: "プラン",
      type: "radio",
      choices: [{ id: "c1", label: "松" }],
    });
    expect(validateAnswer(strict, "梅")).toBe("プラン に無い選択肢が選ばれています");

    const loose = input({
      name: "x",
      label: "プラン",
      type: "radio",
      choices: [
        { id: "c1", label: "松" },
        { id: "c2", label: "その他", isOther: true },
      ],
    });
    expect(validateAnswer(loose, "梅")).toBeNull();
  });

  test("都道府県は一覧の中だけ", () => {
    const block = input({ name: "x", label: "お住まい", type: "prefecture" });
    expect(validateAnswer(block, "東京都")).toBeNull();
    expect(validateAnswer(block, "TOKYO")).toBe("お住まい は都道府県から選んでください");
  });

  test("日付は年月日の形", () => {
    const block = input({ name: "x", label: "希望日", type: "date" });
    expect(validateAnswer(block, "2026-08-19")).toBeNull();
    expect(validateAnswer(block, "2026/8/19")).toBe("希望日 は日付を選んでください");
  });

  test("ファイルは、預けた画像のURLだけを通す", () => {
    const block = input({ name: "x", label: "お写真", type: "file" });
    expect(
      validateAnswer(block, "https://nen-line.example.workers.dev/images/form-uploads/f1/fr1/a.jpg"),
    ).toBeNull();
    // 別の場所を指すURLは、こちらが預かった画像ではない
    expect(validateAnswer(block, "https://example.com/photo.jpg")).toBe(
      "お写真 の画像を送りなおしてください",
    );
    expect(validateAnswer(block, "写真を送りました")).toBe(
      "お写真 の画像を送りなおしてください",
    );
  });

  test("非表示の欄は、必須でも問わない", () => {
    const layout = layoutWith([
      input({ name: "hidden_one", label: "内部用", required: true, hidden: true }),
      input({ name: "x", label: "お名前", required: true }),
    ]);
    expect(validateAnswers(layout, { x: "山田" })).toBeNull();
  });
});

describe("選択肢による分岐", () => {
  function branching(): FormLayout {
    const layout = emptyLayout();
    layout.sections[0].id = "s1";
    layout.sections.push(
      { id: "s2", name: "犬の人", blocks: [] },
      { id: "s3", name: "猫の人", blocks: [] },
    );
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "飼っている子",
        type: "radio",
        choices: [
          { id: "c1", label: "犬", jumpToSectionId: "s2" },
          { id: "c2", label: "猫", jumpToSectionId: "s3" },
          { id: "c3", label: "いない" },
        ],
      }),
    ];
    return layout;
  }

  test("行き先が付いている選択肢は、そこへ飛ぶ", () => {
    const layout = branching();
    expect(nextSectionIndex(layout, 0, { pet: "猫" })).toBe(2);
  });

  test("行き先が無ければ、次のページへ進む", () => {
    const layout = branching();
    expect(nextSectionIndex(layout, 0, { pet: "いない" })).toBe(1);
  });

  test("消えたページを指していたら、次のページへ進む", () => {
    const layout = branching();
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "飼っている子",
        type: "radio",
        choices: [{ id: "c1", label: "犬", jumpToSectionId: "s-deleted" }],
      }),
    ];
    expect(nextSectionIndex(layout, 0, { pet: "犬" })).toBe(1);
  });

  test("複数選択で行き先が2つ出たら、先に書いてあるほうへ", () => {
    const layout = branching();
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "飼っている子",
        type: "checkbox",
        choices: [
          { id: "c1", label: "犬", jumpToSectionId: "s2" },
          { id: "c2", label: "猫", jumpToSectionId: "s3" },
        ],
      }),
    ];
    expect(nextSectionIndex(layout, 0, { pet: ["猫", "犬"] })).toBe(1);
  });

  test("最後のページからは、ページ数を超えた番号が返る（＝送信）", () => {
    const layout = branching();
    expect(nextSectionIndex(layout, 2, {})).toBe(3);
  });
});

describe("フォームのデザイン設定", () => {
  test("5色と許可した見た目だけを正規化する", () => {
    expect(normalizeFormTheme({
      main: "#06C755",
      sub: "#E8F8EE",
      accent: "#175CD3",
      error: "#E5484D",
      text: "#1D1D1F",
      fontFamily: "serif",
      cornerRadius: "round",
      backgroundImageUrl: "https://example.com/form.jpg",
      css: "body { display: none }",
    })).toEqual({
      main: "#06c755",
      sub: "#e8f8ee",
      accent: "#175cd3",
      error: "#e5484d",
      text: "#1d1d1f",
      fontFamily: "serif",
      cornerRadius: "round",
      backgroundImageUrl: "https://example.com/form.jpg",
    });
  });

  test("危険な画像URLと不正な色を既定値へ戻す", () => {
    const theme = normalizeFormTheme({ main: "red", backgroundImageUrl: "javascript:alert(1)" });
    expect(theme.main).toBe("#008f3d");
    expect(theme.backgroundImageUrl).toBeNull();
  });

  test("薄い緑には白文字を置かない", () => {
    const theme = normalizeFormTheme({ main: "#06c755", text: "#1d1d1f" });
    expect(formThemeButtonText(theme)).toBe("#1d1d1f");
  });
});

describe("未回答の判定(FORM-13の土台)", () => {
  test("空文字・空白だけ・null・空配列はすべて未回答", () => {
    expect(isFormAnswerEmpty("")).toBe(true);
    expect(isFormAnswerEmpty("   ")).toBe(true);
    expect(isFormAnswerEmpty(null)).toBe(true);
    expect(isFormAnswerEmpty(undefined)).toBe(true);
    expect(isFormAnswerEmpty([])).toBe(true);
    expect(isFormAnswerEmpty(["", "  "])).toBe(true);
  });

  test("値があれば未回答ではない", () => {
    expect(isFormAnswerEmpty("x")).toBe(false);
    expect(isFormAnswerEmpty(["x"])).toBe(false);
    expect(isFormAnswerEmpty(0)).toBe(false);
  });
});

describe("日付の検証(FORM-09)", () => {
  test("暦に存在しない日付を通さない", () => {
    expect(isCalendarDateString("2026-02-30")).toBe(false);
    expect(isCalendarDateString("2023-02-29")).toBe(false); // 平年
    expect(isCalendarDateString("2026-13-01")).toBe(false);
    expect(isCalendarDateString("2026-00-10")).toBe(false);
    expect(isCalendarDateString("not-a-date")).toBe(false);
    expect(isCalendarDateString("2026-2-3")).toBe(false); // 桁が違う
  });

  test("暦に存在する日付は通す（うるう年を含む）", () => {
    expect(isCalendarDateString("2024-02-29")).toBe(true);
    expect(isCalendarDateString("2026-09-01")).toBe(true);
    expect(isCalendarDateString("2000-02-29")).toBe(true);
  });

  test("回答の検証でも暦日を見る", () => {
    const block = input({ name: "day", label: "希望日", type: "date" });
    expect(validateAnswer(block, "2026-02-30")).toBe("希望日 は存在しない日付です");
    expect(validateAnswer(block, "2026-13-40")).toBe("希望日 は存在しない日付です");
    expect(validateAnswer(block, "2026-09-01")).toBeNull();
    expect(validateAnswer(block, "bad")).toBe("希望日 は日付を選んでください");
  });
});

describe("「その他」の選択(FORM-11の土台)", () => {
  const block = () =>
    input({
      name: "pet",
      label: "ペット",
      type: "radio",
      choices: [
        { id: "c1", label: "犬" },
        { id: "c2", label: "その他", isOther: true },
      ],
    });

  test("自由記入の値でも、その他の選択肢は選ばれた扱いになる", () => {
    const b = block();
    expect(formChoiceIsSelected(b, b.choices![1], ["ハムスター"])).toBe(true);
    expect(formChoiceIsSelected(b, b.choices![0], ["ハムスター"])).toBe(false);
    expect(formChoiceIsSelected(b, b.choices![1], ["犬"])).toBe(false);
  });

  test("その他が無い設問では、ラベルに無い値は選ばれていない", () => {
    const b = input({
      name: "pet",
      label: "ペット",
      type: "radio",
      choices: [{ id: "c1", label: "犬" }],
    });
    expect(formChoiceIsSelected(b, b.choices![0], ["ハムスター"])).toBe(false);
  });

  test("その他に付けた分岐は、自由記入でも発火する", () => {
    const layout = emptyLayout();
    layout.sections.push({ id: "s2", name: "その他の人", blocks: [] });
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "ペット",
        type: "radio",
        choices: [
          { id: "c1", label: "犬" },
          { id: "c2", label: "その他", isOther: true, jumpToSectionId: "s2" },
        ],
      }),
    ];
    expect(nextSectionIndex(layout, 0, { pet: "ハムスター" })).toBe(1);
    expect(nextSectionIndex(layout, 0, { pet: "犬" })).toBe(1); // 次のページへ
  });
});

describe("フォーム定義の検証（保存時。FORM-03/04/12）", () => {
  test("文字数の下限が上限を超える定義は止める", () => {
    const layout = layoutWith([
      input({ name: "x", label: "ひとこと", limit: { min: 100, max: 10 } }),
    ]);
    expect(validateFormDefinition(layout)).toContain("最小文字数が最大文字数を超えています");
  });

  test("0は「制限なし」なので大小比較しない", () => {
    const layout = layoutWith([
      input({ name: "x", label: "ひとこと", limit: { min: 5, max: 0 } }),
    ]);
    expect(validateFormDefinition(layout)).toBeNull();
  });

  test("選択数の下限が上限を超える・選べる数より多い下限は止める", () => {
    const layout = layoutWith([
      input({
        name: "fav",
        label: "好きなもの",
        type: "checkbox",
        selectionLimit: { min: 3, max: 1 },
        choices: [
          { id: "c1", label: "犬" },
          { id: "c2", label: "猫" },
          { id: "c3", label: "鳥" },
        ],
      }),
    ]);
    expect(validateFormDefinition(layout)).toContain("下限が上限を超えています");

    const impossible = layoutWith([
      input({
        name: "fav",
        label: "好きなもの",
        type: "checkbox",
        selectionLimit: { min: 5 },
        choices: [
          { id: "c1", label: "犬" },
          { id: "c2", label: "猫" },
        ],
      }),
    ]);
    expect(validateFormDefinition(impossible)).toContain("つ以上選ぶ設定");
  });

  test("ラジオの初期選択が2つあると止める", () => {
    const layout = layoutWith([
      input({
        name: "plan",
        label: "プラン",
        type: "radio",
        choices: [
          { id: "c1", label: "松", defaultSelected: true },
          { id: "c2", label: "竹", defaultSelected: true },
        ],
      }),
    ]);
    expect(validateFormDefinition(layout)).toContain("はじめから選んでおく");
  });

  test("定員は1以上の整数だけ。小数・0・空は止める", () => {
    const withCapacity = (limit: number | undefined) =>
      layoutWith([
        input({
          name: "slot",
          label: "希望の回",
          type: "radio",
          choices: [{ id: "c1", label: "午前", capacity: { enabled: true, limit } }],
        }),
      ]);
    expect(validateFormDefinition(withCapacity(2.5))).toContain("整数");
    expect(validateFormDefinition(withCapacity(0))).toContain("整数");
    expect(validateFormDefinition(withCapacity(undefined))).toContain("整数");
    expect(validateFormDefinition(withCapacity(3))).toBeNull();
  });
});

describe("公開前の検査(FORM-05/07/14)", () => {
  function twoPages(): FormLayout {
    const layout = emptyLayout();
    layout.sections[0].id = "s1";
    layout.sections.push({ id: "s2", name: "2ページ目", blocks: [] });
    return layout;
  }

  test("正しい分岐は通す", () => {
    const layout = twoPages();
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "ペット",
        type: "radio",
        choices: [{ id: "c1", label: "犬", jumpToSectionId: "s2" }],
      }),
    ];
    expect(validateFormForPublish(layout)).toBeNull();
  });

  test("自分自身・前のページへの分岐は循環として止める", () => {
    const selfLoop = twoPages();
    selfLoop.sections[0].blocks = [
      input({
        name: "pet",
        label: "ペット",
        type: "radio",
        choices: [{ id: "c1", label: "犬", jumpToSectionId: "s1" }],
      }),
    ];
    expect(validateFormForPublish(selfLoop)).toContain("循環");

    const backJump = twoPages();
    backJump.sections[1].blocks = [
      input({
        name: "redo",
        label: "もう一度",
        type: "radio",
        choices: [{ id: "c1", label: "最初へ", jumpToSectionId: "s1" }],
      }),
    ];
    expect(validateFormForPublish(backJump)).toContain("循環");
  });

  test("消えたページを指す分岐は止める", () => {
    const layout = twoPages();
    layout.sections[0].blocks = [
      input({
        name: "pet",
        label: "ペット",
        type: "radio",
        choices: [{ id: "c1", label: "犬", jumpToSectionId: "s-gone" }],
      }),
    ];
    expect(validateFormForPublish(layout)).toContain("もう無いページ");
  });

  test("共通ヘッダの分岐は公開時に止める（下書き保存は許す）", () => {
    const layout = twoPages();
    layout.header = [
      input({
        name: "kind",
        label: "種別",
        type: "radio",
        choices: [{ id: "c1", label: "犬", jumpToSectionId: "s2" }],
      }),
    ];
    expect(validateFormForPublish(layout)).toContain("共通ヘッダ");
    // 定義としては成り立つので保存は通る
    expect(validateFormDefinition(layout)).toBeNull();
  });

  test("選ぶ先が空の動作は公開で止める", () => {
    const layout = layoutWith([input({ name: "x", label: "ひとこと" })]);
    layout.options.afterActions = [{ kind: "send_text", text: "  " }];
    expect(validateFormForPublish(layout)).toContain("本文");

    const noTemplate = layoutWith([input({ name: "x", label: "ひとこと" })]);
    noTemplate.options.afterActions = [{ kind: "send_template", templateId: "" }];
    expect(validateFormForPublish(noTemplate)).toContain("テンプレート");

    const noTag = layoutWith([input({ name: "x", label: "ひとこと" })]);
    noTag.options.afterActions = [{ kind: "tag", op: "add", tagIds: [] }];
    expect(validateFormForPublish(noTag)).toContain("タグ");

    const noField = layoutWith([input({ name: "x", label: "ひとこと" })]);
    noField.options.afterActions = [{ kind: "friend_field", fieldId: "", value: "済" }];
    expect(validateFormForPublish(noField)).toContain("情報欄");
  });

  test("日付リマインダをONにしたのに対象が空なら公開で止める", () => {
    const layout = layoutWith([
      input({
        name: "day",
        label: "希望日",
        type: "date",
        reminder: { reminderId: "", time: "09:00" },
      }),
    ]);
    expect(validateFormForPublish(layout)).toContain("日付リマインダ");
    // 対象を選べば通る
    layout.sections[0].blocks[0] = {
      ...(layout.sections[0].blocks[0] as FormInputBlock),
      reminder: { reminderId: "rm-1", time: "09:00" },
    };
    expect(validateFormForPublish(layout)).toBeNull();
  });
});

describe("画像ブロックのURL検証（保存時。R197）", () => {
  function layoutWithImage(mediaUrl: string, linkUrl?: string): FormLayout {
    const layout = emptyLayout();
    const image: FormBlock =
      linkUrl === undefined
        ? { id: "img1", kind: "image", mediaUrl }
        : { id: "img1", kind: "image", mediaUrl, linkUrl };
    layout.sections[0].blocks = [input({ name: "x", label: "ひとこと" }), image];
    return layout;
  }

  test("URLでない画像URL・リンクは保存で止める", () => {
    expect(validateFormDefinition(layoutWithImage("not-a-url"))).toContain("URLの形ではありません");
    expect(validateFormDefinition(layoutWithImage("https://example.com/a.png", "not-a-url"))).toContain(
      "URLの形ではありません",
    );
  });

  test("正しいhttps URLと未指定は通す", () => {
    expect(
      validateFormDefinition(layoutWithImage("https://example.com/a.png", "https://example.com/go")),
    ).toBeNull();
    expect(validateFormDefinition(layoutWithImage(""))).toBeNull();
  });
});

describe("初期値の公開前検証（R196）", () => {
  test("形式と矛盾する初期値は対象欄と理由を示して止める", () => {
    const badMail = layoutWith([
      input({ name: "mail", label: "メール", limit: { format: "email" }, defaultValue: "not-an-email" }),
    ]);
    expect(validateFormForPublish(badMail)).toContain("初期値");

    const badDate = layoutWith([input({ name: "day", label: "希望日", type: "date", defaultValue: "2026-02-30" })]);
    expect(validateFormForPublish(badDate)).toContain("初期値");

    const badPref = layoutWith([
      input({ name: "pref", label: "住まい", type: "prefecture", defaultValue: "存在しない県" }),
    ]);
    expect(validateFormForPublish(badPref)).toContain("初期値");
  });

  test("合っている初期値・空の初期値は通す（下書き保存も通す）", () => {
    const good = layoutWith([
      input({ name: "mail", label: "メール", limit: { format: "email" }, defaultValue: "a@example.com" }),
      input({ name: "day", label: "希望日", type: "date", defaultValue: "2026-03-01" }),
      input({ name: "pref", label: "住まい", type: "prefecture", defaultValue: "東京都" }),
      input({ name: "memo", label: "メモ", required: true }),
    ]);
    expect(validateFormForPublish(good)).toBeNull();

    const draft = layoutWith([
      input({ name: "mail", label: "メール", limit: { format: "email" }, defaultValue: "not-an-email" }),
    ]);
    // 下書きでは許す（公開の直前で止める）
    expect(validateFormDefinition(draft)).toBeNull();
  });
});

/**
 * P（回答フォームの読みにくい色）：文字（text）と背景（sub）の差が
 * 4.5:1 未満なら注意を返す。保存・公開は妨げない。比は WCAG の式で測り、独立に python で
 * 検算した値（既定 15.3・#999/白 2.8・#777/白 4.4・同色 1.0）と突き合わせる。
 */
describe("文字と背景のコントラスト（P）", () => {
  test("既定の組み合わせは通る", () => {
    expect(formThemeContrastError(FORM_THEME_DEFAULT)).toBeNull();
  });

  test("4.5未満は測った比を注意の文に入れる", () => {
    const error = formThemeContrastError({
      ...FORM_THEME_DEFAULT,
      text: "#999999",
      sub: "#ffffff",
    });
    expect(error).toContain("読みづらい可能性");
    expect(error).toContain("いま 2.8:1");
    expect(error).toContain("4.5:1以上");
  });

  test("同じ色は 1:1 の注意を返す", () => {
    const error = formThemeContrastError({
      ...FORM_THEME_DEFAULT,
      text: "#ffffff",
      sub: "#ffffff",
    });
    expect(error).toContain("いま 1:1");
  });

  test("4.5未満（#777/白 = 4.47）は注意を返す", () => {
    expect(
      formThemeContrastError({
        ...FORM_THEME_DEFAULT,
        text: "#777777",
        sub: "#ffffff",
      }),
    ).toContain("読みづらい可能性");
  });

  test("公開前の検査は読みにくい色で止めない", () => {
    const layout = layoutWith([
      input({ name: "name", label: "お名前", type: "text" }),
    ]);
    layout.options.theme = {
      ...FORM_THEME_DEFAULT,
      text: "#999999",
      sub: "#ffffff",
    };
    expect(validateFormForPublish(layout)).toBeNull();
    layout.options.theme = { ...FORM_THEME_DEFAULT };
    expect(validateFormForPublish(layout)).toBeNull();
  });
});

test('チェックボックスの上限0は制限なしとして公開・回答の両方で扱う', () => {
  const question = input({ name: 'selected', label: '選択', type: 'checkbox', required: true,
    choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], selectionLimit: { min: 1, max: 0 } });
  const layout = emptyLayout();
  layout.sections[0]!.blocks = [question];
  expect(validateFormForPublish(layout)).toBeNull();
  expect(validateAnswers(layout, { selected: ['A', 'B'] })).toBeNull();
});

test('分岐で通らなかったセクションの必須欄は要求しない', () => {
  const layout = emptyLayout();
  layout.header = [input({ name: 'header', required: true })];
  layout.sections = [
    { id: 'first', name: 'First', blocks: [input({ name: 'branch', type: 'radio', required: true,
      choices: [{ id: 'skip', label: 'skip', jumpToSectionId: 'last' }, { id: 'all', label: 'all' }] })] },
    { id: 'middle', name: 'Middle', blocks: [input({ name: 'skipped', required: true })] },
    { id: 'last', name: 'Last', blocks: [input({ name: 'final', required: true })] },
  ];
  expect(validateAnswers(layout, { header: 'header', branch: 'skip', final: 'done' })).toBeNull();
  expect(validateAnswers(layout, { header: 'header', branch: 'all', final: 'done' })).toContain('skipped');
  expect(validateAnswers(layout, { branch: 'skip', final: 'done' })).toContain('header');
  expect(validateAnswers(layout, { header: 'header', branch: 'skip' })).toContain('final');
});
