-- 0008: Google Analytics 4 (connected through Composio) as a source of active
-- users, next to paying customers, a number you set, and PostHog. See
-- docs/CONNECTORS.md. Only widens the allowed values; no data changes.

alter table public.profiles drop constraint if exists profiles_users_source_check;
alter table public.profiles add constraint profiles_users_source_check
  check (users_source in ('customers', 'manual', 'posthog', 'ga4'));

alter table public.connections drop constraint if exists connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('stripe', 'github', 'posthog', 'ga4'));

alter table public.connection_breaks drop constraint if exists connection_breaks_provider_check;
alter table public.connection_breaks add constraint connection_breaks_provider_check
  check (provider in ('stripe', 'github', 'posthog', 'ga4'));
