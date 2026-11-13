-- =============================================================================
-- API oficial: conexão pelo cadastro incorporado da Meta (Embedded Signup).
-- O cliente entra com o Facebook, escolhe o próprio Business Manager e o número;
-- o CRO recebe o token da empresa, liga o webhook e registra o número sozinho.
-- =============================================================================
alter table public.wa_cloud_credentials add column if not exists source text not null default 'manual'
  check (source in ('manual', 'embedded'));
alter table public.wa_cloud_credentials add column if not exists business_id text;
alter table public.wa_cloud_credentials add column if not exists pin_enc text;

-- a tela mostra como a conexão foi feita e o Business Manager
do $$
declare d text;
begin
  d := pg_get_functiondef('public.wa_channel_get(uuid)'::regprocedure);
  d := replace(d, '''token_hint'', cr.token_hint,', '''token_hint'', cr.token_hint, ''source'', cr.source, ''business_id'', cr.business_id,');
  execute d;
end $$;

create or replace function public.wa_cloud_secret(p_instance uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('instance_id', i.id, 'tenant_id', i.tenant_id, 'status', i.status,
                            'phone_number_id', i.metadata->>'phone_number_id', 'waba_id', i.metadata->>'waba_id',
                            'access_token_enc', c.access_token_enc, 'app_secret_enc', c.app_secret_enc, 'verify_token', c.verify_token,
                            'source', c.source)
    from public.whatsapp_instances i join public.wa_cloud_credentials c on c.instance_id = i.id
   where i.id = p_instance and i.provider = 'cloud_api';
$$;
revoke all on function public.wa_cloud_secret(uuid) from public, anon, authenticated;
grant execute on function public.wa_cloud_secret(uuid) to service_role;
