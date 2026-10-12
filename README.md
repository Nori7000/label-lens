# ラベルレンズ

食品のバーコードや袋の裏の表示を撮るだけで、原材料を ◯ △ × でひと目で判定するスマホ向けWebアプリ。Blue Leaf Studio 制作。
有料版一本（最初の7日間無料 → 月額380円・税込、自動更新）。割引や年払いはなし。

## ファイル

| ファイル | 内容 |
|---|---|
| `index.html` | アプリ本体（紹介・申込み・判定ルール・画面すべて） |
| `config.js` | ブラウザ用の Supabase 接続先（公開してよいキーだけ） |
| `functions/api/[action].js` | サーバー側：`checkout`（申込み）`portal`（解約）`webhook`（Stripe通知）`read`（AI読み取り） |
| `supabase/schema.sql` | テーブル（商品・契約・読み取り回数）。SQL Editor で1回実行 |
| `tokushoho.html` `terms.html` `privacy.html` | 特定商取引法の表記・利用規約・プライバシーポリシー（【要記入】を埋める） |
| `manifest.webmanifest` `sw.js` `icon*` | ホーム画面に追加してアプリとして起動するための設定 |

## 公開先：Cloudflare Pages（環境変数）

| 名前 | 中身 |
|---|---|
| `SUPABASE_URL` | Supabase の Project URL |
| `SUPABASE_ANON_KEY` | publishable（anon）キー |
| `SUPABASE_SERVICE_KEY` | secret（service_role）キー ※サーバー専用。絶対にブラウザに出さない |
| `STRIPE_SECRET_KEY` | Stripe のシークレットキー |
| `STRIPE_WEBHOOK_SECRET` | Stripe の Webhook 署名シークレット（`whsec_`） |
| `STRIPE_PRICE_MONTHLY` | 380円/月 の価格ID |
| `ANTHROPIC_API_KEY` | AI読み取り用 |
| `ANTHROPIC_MODEL` | 省略可（既定 `claude-haiku-5-5`） |
| `SITE_URL` | 公開URL（例 `https://label-lens.pages.dev`） |

Stripe の Webhook 送信先：`{SITE_URL}/api/webhook`、イベント：`customer.subscription.created / updated / deleted`。
Stripe のカスタマーポータルで「解約」を有効にする。Supabase の Authentication → URL Configuration の Site URL を `SITE_URL` にする。

## 商品の調べ方（順番）

1. みんなが登録した商品（`ll_products`）
2. Open Food Facts（世界の食品データベース。ODbL）
3. どちらにもなければ袋の裏を撮る → AIが読み取り、そのバーコードに登録。次からは誰でもバーコードだけで判定できる

AI読み取りは1人1日100回まで（費用の上振れ防止）。

## 判定ルール

アプリ内の「判定のルールと出典」に全文。会社名・ブランド名では判定せず、原材料と種類別だけで判定する。
