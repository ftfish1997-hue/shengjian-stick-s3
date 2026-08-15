create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- DAILY_REVIEW_TOKEN must exist both as an Edge Function Secret and as the
-- Vault secrets named project_url and daily_review_token before this job
-- starts running. project_url is the base URL of the deployer's own project.
-- pg_cron uses UTC: 16:10 UTC is 00:10 Asia/Shanghai on the following day.
do $$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'daily-review-every-day'
  ) then
    perform cron.schedule(
      'daily-review-every-day',
      '10 16 * * *',
      $job$
      select net.http_post(
        url := rtrim((
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'project_url'
        ), '/') || '/functions/v1/daily-review',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'daily_review_token'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 35000
      ) as request_id;
      $job$
    );
  end if;
end
$$;
