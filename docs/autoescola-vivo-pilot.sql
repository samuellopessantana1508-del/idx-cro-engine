-- Piloto Autoescola Vivo
-- 1) Rode a migration principal.
-- 2) Crie um usuário no Supabase Auth.
-- 3) Substitua AUTH_USER_ID, PIXEL_ID e CAPI_TOKEN abaixo.

insert into public.tenants (slug, name, whatsapp_number, timezone)
values ('autoescola-vivo', 'Autoescola Vivo', '5564999999999', 'America/Sao_Paulo')
on conflict (slug) do update
set name = excluded.name,
    whatsapp_number = excluded.whatsapp_number,
    timezone = excluded.timezone;

insert into public.offers (tenant_id, name, slug, category, price, default_message)
select
  t.id,
  'CNH Categoria B',
  'cnh-b',
  'Autoescola',
  2290.00,
  'Olá! Tenho interesse em CNH Categoria B. Ref: {{ref}}'
from public.tenants t
where t.slug = 'autoescola-vivo'
on conflict (tenant_id, slug) do update
set name = excluded.name,
    category = excluded.category,
    price = excluded.price,
    default_message = excluded.default_message;

insert into public.smart_links (
  tenant_id,
  offer_id,
  code,
  name,
  message_template,
  default_utm_source,
  default_utm_medium,
  default_utm_campaign,
  default_utm_content
)
select
  t.id,
  o.id,
  'cnhb-instagram',
  'CNH B - Instagram',
  'Olá! Tenho interesse em CNH Categoria B. Ref: {{ref}}',
  'meta',
  'paid',
  'cnh-b-piloto',
  'criativo-01'
from public.tenants t
join public.offers o on o.tenant_id = t.id and o.slug = 'cnh-b'
where t.slug = 'autoescola-vivo'
on conflict (code) do update
set name = excluded.name,
    message_template = excluded.message_template,
    default_utm_source = excluded.default_utm_source,
    default_utm_medium = excluded.default_utm_medium,
    default_utm_campaign = excluded.default_utm_campaign,
    default_utm_content = excluded.default_utm_content;

-- Vincule o usuário admin do painel ao tenant.
insert into public.tenant_users (tenant_id, user_id, role)
select t.id, 'AUTH_USER_ID'::uuid, 'owner'
from public.tenants t
where t.slug = 'autoescola-vivo'
on conflict (tenant_id, user_id) do update
set role = excluded.role,
    status = 'active';

-- Credenciais Meta CAPI. O token não aparece no frontend.
insert into public.tenant_meta_credentials (
  tenant_id,
  pixel_id,
  access_token,
  graph_version,
  enabled
)
select
  t.id,
  'PIXEL_ID',
  'CAPI_TOKEN',
  'v25.0',
  true
from public.tenants t
where t.slug = 'autoescola-vivo'
on conflict (tenant_id) do update
set pixel_id = excluded.pixel_id,
    access_token = excluded.access_token,
    graph_version = excluded.graph_version,
    enabled = true,
    updated_at = now();

