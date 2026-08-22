-- Colaboradores must not see fee_mensal.
-- Replace the broad SELECT grant with a view that masks the column.

begin;

-- 1. Revoke direct SELECT on clientes from authenticated
--    (INSERT/UPDATE/DELETE stay — RLS still guards them)
revoke select on public.clientes from authenticated;

-- 2. Create a view that zeroes out fee for non-admins
create or replace view public.clientes_v as
select
  id,
  nome,
  nicho,
  case when private.is_idx_admin() then fee_mensal else 0 end as fee_mensal,
  data_inicio,
  email,
  telefone,
  responsavel,
  plataformas,
  cpa_meta,
  cpm_meta,
  ctr_meta,
  cpc_meta,
  cpa_real,
  cpm_medio,
  ctr_medio,
  cpc_medio,
  observacoes,
  ativo,
  created_at,
  updated_at
from public.clientes;

-- 3. Grant SELECT on the view to authenticated
grant select on public.clientes_v to authenticated;

comment on view public.clientes_v is
  'Read-only projection of clientes that hides fee_mensal from non-admin users.';

commit;
