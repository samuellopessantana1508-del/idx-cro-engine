create or replace view public.vw_tenant_isolation_audit
with (security_invoker = true) as
select
  t.id as tenant_id,
  t.name as tenant_name,
  t.slug as tenant_slug,
  t.status as tenant_status,
  (
    select count(*)
    from public.tenant_users tu
    where tu.tenant_id = t.id
  ) as tenant_users,
  (
    select count(*)
    from public.offers o
    where o.tenant_id = t.id
  ) as offers,
  (
    select count(*)
    from public.smart_links sl
    where sl.tenant_id = t.id
  ) as smart_links,
  (
    select count(*)
    from public.tracking_sessions ts
    where ts.tenant_id = t.id
  ) as tracking_sessions,
  (
    select count(*)
    from public.crm_activities ca
    where ca.tenant_id = t.id
  ) as crm_activities,
  (
    select count(*)
    from public.capi_events ce
    where ce.tenant_id = t.id
  ) as capi_events,
  (
    select count(*)
    from public.meta_campaign_insights mi
    where mi.tenant_id = t.id
  ) as meta_insight_rows,
  greatest(
    coalesce(t.updated_at, t.created_at),
    coalesce((
      select max(ts.created_at)
      from public.tracking_sessions ts
      where ts.tenant_id = t.id
    ), t.created_at),
    coalesce((
      select max(ca.created_at)
      from public.crm_activities ca
      where ca.tenant_id = t.id
    ), t.created_at),
    coalesce((
      select max(ce.created_at)
      from public.capi_events ce
      where ce.tenant_id = t.id
    ), t.created_at),
    coalesce((
      select max(mi.synced_at)
      from public.meta_campaign_insights mi
      where mi.tenant_id = t.id
    ), t.created_at)
  ) as last_activity_at
from public.tenants t;

grant select on public.vw_tenant_isolation_audit to authenticated;
