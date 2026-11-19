-- Таблицы переводчика в Supabase.
-- kv: исправления с сайта (разговорник "all", проверка "review", "distilled") — пишет только серверная функция.
-- phrases: копия базы пар data/phrases.json, чтобы её было видно и можно было править в панели Supabase.
create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.phrases (
  id text primary key,
  kind text not null,
  ru text not null,
  inh text not null,
  source text,
  verified boolean not null default false,
  also text[],
  note text,
  count integer,
  license text,
  rare boolean
);
create index if not exists phrases_ru_idx on public.phrases (lower(ru));
create index if not exists phrases_inh_idx on public.phrases (lower(inh));

-- Доступ только с серверным ключом: включаем RLS без политик, публичный ключ ничего не видит.
alter table public.kv enable row level security;
alter table public.phrases enable row level security;
