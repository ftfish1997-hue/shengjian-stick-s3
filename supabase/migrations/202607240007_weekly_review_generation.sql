alter table public.weekly_reviews
  add column if not exists generation_attempts integer not null default 0,
  add column if not exists last_generation_started_at timestamptz,
  add column if not exists error_code text;

alter table public.weekly_reviews
  drop constraint if exists weekly_reviews_status_check,
  drop constraint if exists weekly_reviews_generation_attempts_check;

alter table public.weekly_reviews
  add constraint weekly_reviews_status_check check (
    status in ('pending', 'generating', 'generated', 'synced', 'failed')
  ),
  add constraint weekly_reviews_generation_attempts_check check (
    generation_attempts between 0 and 4
  );

create index if not exists weekly_reviews_generation_idx
  on public.weekly_reviews (status, updated_at);
