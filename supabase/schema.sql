-- ラベルレンズ：Supabase の SQL Editor に貼り付けて「Run」を1回押すだけ。
-- Blue Leaf Striker と同じプロジェクトで動きます（テーブル名が ll_ で始まるので混ざりません）。

-- みんなで共有する商品データ（会員なら誰でも読める。書き込みはサーバーだけ）
create table if not exists public.ll_products (
  jan           text primary key check (jan ~ '^([0-9]{8}|[0-9]{13})$'),
  name          text not null default '' check (char_length(name) <= 80),
  category      text not null default '' check (char_length(category) <= 40),
  ingredients   text not null check (char_length(ingredients) between 2 and 2000),
  juice_percent numeric check (juice_percent between 0 and 100),
  nutrition     jsonb not null default '{}'::jsonb,
  added_by      uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
alter table public.ll_products enable row level security;
drop policy if exists "ll_products read" on public.ll_products;
create policy "ll_products read" on public.ll_products for select to authenticated using (true);

-- 会員の契約状態（Stripe からの通知でサーバーが書き込む。本人は自分の分だけ読める）
create table if not exists public.ll_subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text not null default 'none',   -- trialing / active / past_due / canceled など
  plan                   text,                            -- month / year
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  trial_used             boolean not null default false,
  updated_at             timestamptz not null default now()
);
alter table public.ll_subscriptions enable row level security;
drop policy if exists "ll_subscriptions own" on public.ll_subscriptions;
create policy "ll_subscriptions own" on public.ll_subscriptions for select to authenticated using (auth.uid() = user_id);

-- AI読み取りの回数（1日の上限チェック用。サーバーだけが使う）
create table if not exists public.ll_reads (
  id      bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists ll_reads_user_at on public.ll_reads (user_id, at);
alter table public.ll_reads enable row level security;
