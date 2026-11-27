/** 一覧の右の詳細面と、埋め込みの補助欄。実際の入口を開いて測る。 */
export const detailSurfaceCases = [
  {
    "key": "scenarios",
    "label": "シナリオ",
    "path": "/scenarios?scenario=scenario-0",
    "kind": "DetailPanel"
  },
  {
    "key": "broadcasts",
    "label": "一斉配信",
    "path": "/broadcasts?broadcast=broadcast-0",
    "kind": "DetailPanel"
  },
  {
    "key": "templates",
    "label": "テンプレート",
    "path": "/templates?row=template-0",
    "kind": "DetailPanel"
  },
  {
    "key": "auto-replies",
    "label": "自動応答",
    "path": "/auto-replies?reply=ar-1",
    "kind": "DetailPanel"
  },
  {
    "key": "reminders",
    "label": "リマインダ",
    "path": "/reminders?reminder=reminder-1",
    "kind": "DetailPanel"
  },
  {
    "key": "tags",
    "label": "タグ",
    "path": "/tags?tag=tag-ec-customer",
    "kind": "DetailPanel"
  },
  {
    "key": "marks",
    "label": "対応マーク",
    "path": "/tags?tab=marks&mark=mark-default",
    "kind": "DetailPanel"
  },
  {
    "key": "fields",
    "label": "友だち情報欄",
    "path": "/tags?tab=fields&field=field-dog-name",
    "kind": "DetailPanel"
  },
  {
    "key": "saved-searches",
    "label": "保存した検索",
    "path": "/tags?tab=searches&search=ss-1",
    "kind": "DetailPanel"
  },
  {
    "key": "forms",
    "label": "回答フォーム",
    "path": "/form-submissions?form=form-1",
    "kind": "DetailPanel"
  },
  {
    "key": "events",
    "label": "イベント",
    "path": "/events?event=ev-1",
    "kind": "DetailPanel"
  },
  {
    "key": "webinars",
    "label": "ウェビナー",
    "path": "/webinars?webinar=webinar-1",
    "kind": "DetailPanel"
  },
  {
    "key": "conversions",
    "label": "成果地点",
    "path": "/conversions?point=cp-1",
    "kind": "DetailPanel"
  },
  {
    "key": "common-vars",
    "label": "共通情報",
    "path": "/contents/vars?row=common-var-delete-target",
    "kind": "DetailPanel"
  },
  {
    "key": "rich-menus",
    "label": "リッチメニュー",
    "path": "/rich-menus?menu=rich-menu-target",
    "kind": "DetailPanel"
  },
  {
    "key": "automation-runs",
    "label": "自動処理の実行記録",
    "path": "/automations/runs?run=run-1",
    "kind": "DetailPanel"
  },
  {
    "key": "affiliates",
    "label": "紹介者",
    "path": "/affiliates?affiliate=af-1",
    "kind": "Drawer",
    "actions": []
  },
  {
    "key": "ai-answer-log",
    "label": "AIの回答記録",
    "path": "/auto-replies?tab=ai-log&log=ail-1",
    "kind": "Drawer",
    "actions": []
  },
  {
    "key": "store-comparison",
    "label": "店の比較",
    "path": "/hq/store-comparison",
    "kind": "Drawer",
    "actions": [
      "tbody tr[data-row-id] >> nth=0"
    ]
  },
  {
    "key": "customer-segments",
    "label": "お客さまの分け方",
    "path": "/analytics?tab=segments",
    "kind": "Drawer",
    "actions": [
      {
        "role": "button",
        "name": "全員を見る"
      }
    ]
  },
  {
    "key": "ec-orders",
    "label": "EC注文の状況",
    "path": "/ec-commerce",
    "kind": "Drawer",
    "actions": [
      "tbody tr[data-row-id] button[aria-haspopup=\"menu\"] >> nth=0",
      {
        "role": "menuitem",
        "name": "注文の状況を見る"
      }
    ]
  },
  {
    "key": "identity-candidates",
    "label": "会員のつき合わせ",
    "path": "/ec-commerce/identity-candidates?candidate=ec-identity-1",
    "kind": "Drawer",
    "actions": []
  },
  {
    "key": "nen-campaigns",
    "label": "NEN配信の見本",
    "path": "/nen-campaigns",
    "kind": "Drawer",
    "actions": [
      "tbody tr[data-row-id] >> nth=0"
    ]
  },
  {
    "key": "staff-calendar",
    "label": "予約担当者のカレンダー",
    "path": "/booking/menus?tab=staff&staff=bs-1",
    "kind": "Drawer",
    "actions": []
  },
  {
    "key": "friend-entitlements",
    "label": "友だちの回数券履歴",
    "path": "/friends/detail?id=friend-1&tab=orders",
    "kind": "Drawer",
    "actions": [
      "button[title$=\"の履歴を見る\"] >> nth=0"
    ]
  },
  {
    "key": "health-summary",
    "label": "健康日記30日のまとめ",
    "path": "/nen/health",
    "kind": "Drawer",
    "actions": [
      "tbody tr button[aria-haspopup=\"menu\"] >> nth=0",
      {
        "role": "menuitem",
        "name": "30日のまとめ"
      }
    ]
  },
  {
    "key": "booking-menu-history",
    "label": "予約メニューの版の履歴",
    "path": "/booking/menus",
    "kind": "Drawer",
    "actions": [
      {
        "role": "button",
        "name": "「トリミング（小型犬）」のそのほかの操作"
      },
      {
        "role": "menuitem",
        "name": "版の履歴"
      }
    ]
  },
  {
    "key": "restaurant-reservations",
    "label": "飲食店の予約台帳",
    "path": "/restaurant-test/reservations?view=list",
    "kind": "DetailColumns",
    "selector": "[data-detail-columns] > aside"
  },
  {
    "key": "restaurant-tables",
    "label": "飲食店の卓",
    "path": "/restaurant-test/tables",
    "kind": "DetailColumns",
    "selector": "[data-detail-columns] > aside"
  },
  {
    "key": "restaurant-inventory",
    "label": "飲食店の予約枠",
    "path": "/restaurant-test/inventory",
    "kind": "DetailColumns",
    "selector": "[data-detail-columns] > aside"
  },
  {
    "key": "restaurant-line-followup",
    "label": "LINE来店フォローの届き方",
    "path": "/restaurant-test/line-followup",
    "kind": "MessagePreview",
    "actions": ["article[aria-label=\"予約したとき\"] button:has-text(\"変更する\")"],
    "selector": "aside[aria-label=\"届き方\"]"
  },
  {
    "key": "saved-analysis-history",
    "label": "保存した分析の履歴",
    "path": "/analytics?tab=saved",
    "kind": "DetailColumns",
    "selector": "[data-detail-columns] > aside"
  },
  {
    "key": "form-responses",
    "label": "集まった回答の詳細",
    "path": "/form-submissions/responses?id=form-1",
    "kind": "DetailColumns",
    "selector": "aside[aria-label=\"回答の詳細・絞り込み\"]",
    "actions": [
      "text=\"1件ずつ見る\"",
      "main tbody tr[aria-selected] button >> nth=0"
    ]
  }
]
