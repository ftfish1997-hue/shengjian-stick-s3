alter table public.daily_reviews
  add column if not exists generation_attempts integer not null default 0,
  add column if not exists last_generation_started_at timestamptz,
  add column if not exists error_code text;

alter table public.daily_reviews
  drop constraint if exists daily_reviews_status_check;

alter table public.daily_reviews
  add constraint daily_reviews_status_check check (
    status in ('pending', 'generating', 'generated', 'synced', 'failed')
  ),
  add constraint daily_reviews_generation_attempts_check check (
    generation_attempts between 0 and 4
  );

create index if not exists daily_reviews_generation_idx
  on public.daily_reviews (status, updated_at);
