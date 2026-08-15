create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- RETRY_FAILURES_TOKEN must exist both as an Edge Function Secret and as the
-- Vault secrets named project_url and retry_failures_token before this job
-- starts running. project_url is the base URL of the deployer's own project.
do $$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'retry-failures-every-5-minutes'
  ) then
    perform cron.schedule(
      'retry-failures-every-5-minutes',
      '*/5 * * * *',
      $job$
      select net.http_post(
        url := rtrim((
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'project_url'
        ), '/') || '/functions/v1/retry-failures',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'retry_failures_token'
          )
        ),
        body := jsonb_build_object('limit', 5),
        timeout_milliseconds := 20000
      ) as request_id;
      $job$
    );
  end if;
end
$$;
