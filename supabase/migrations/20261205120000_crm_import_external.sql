-- Importar leads/negociações de outros CRMs (RD Station CRM e Marketing, Pipedrive, HubSpot, Kommo, planilhas).
--  * Etapa que não existe no funil → vai para a 1ª etapa (o nome original fica anotado), em vez de dar erro
--  * Negociações vendidas/perdidas: ignoradas por padrão, ou importadas como ganhas/perdidas
--  * Valor "R$ 1.234,56" / "1234.56", datas "25/12/2026", vários telefones na mesma célula
--  * Anotações, responsável, funil e etapa de origem vão para o histórico do contato e da negociação
--  * Reimportar o mesmo arquivo não duplica negociações (id de origem)
--  * Importar NÃO dispara automações, cadências nem fluxos de WhatsApp (gatilhos pausados só durante a importação)

-- Gatilhos que disparam ações (mensagens, tarefas, cadências) ficam quietos enquanto idx.importing = '1'
do $$
declare
  f text; def text; patched text;
  guard text := E'begin\n  if coalesce(current_setting(''idx.importing'', true), '''') = ''1'' then return null; end if;';
begin
  foreach f in array array[
    'idx_private.crm_contact_automation_trigger()', 'idx_private.wa_flow_on_contact_tags()',
    'idx_private.crm_deal_automation_trigger()', 'idx_private.crm_cadence_on_deal()', 'idx_private.wa_flow_on_deal_stage()'] loop
    def := pg_get_functiondef(f::regprocedure);
    if position('idx.importing' in def) > 0 then continue; end if;   -- já protegido
    patched := regexp_replace(def, '(\$function\$.*?)\mbegin\M', '\1' || replace(guard, '\', '\\'), 'i');
    if patched = def then raise exception 'não foi possível proteger %', f; end if;
    execute patched;
  end loop;
end $$;

-- "R$ 1.234,56" → 1234.56 ; "1234.56" → 1234.56 ; "1.234" → 1234
create or replace function idx_private.parse_money(p text)
returns numeric language plpgsql immutable set search_path = pg_temp
as $$
declare s text := regexp_replace(coalesce(p, ''), '[^0-9,.\-]', '', 'g');
begin
  if s = '' or s = '-' then return null; end if;
  if position(',' in s) > 0 and position('.' in s) > 0 then
    if strpos(reverse(s), ',') < strpos(reverse(s), '.') then s := replace(replace(s, '.', ''), ',', '.');   -- 1.234,56
    else s := replace(s, ',', ''); end if;                                                                  -- 1,234.56
  elsif position(',' in s) > 0 then
    s := replace(s, ',', '.');
    if s ~ '\.\d{3}$' and s !~ '^\d{1,3}\.\d{3}$' then s := replace(s, '.', ''); end if;
  elsif s ~ '\.\d{3}$' and s ~ '^\d{1,3}(\.\d{3})+$' then
    s := replace(s, '.', '');                                                                               -- 1.234 = mil
  end if;
  return round(s::numeric, 2);
exception when others then return null;
end $$;

-- "25/12/2026", "2026-12-25", "25/12/2026 14:30" → date
create or replace function idx_private.parse_date_br(p text)
returns date language plpgsql immutable set search_path = pg_temp
as $$
declare s text := trim(coalesce(p, ''));
begin
  if s = '' then return null; end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{4}' then return to_date(substring(s from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY'); end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{2}\M' then return to_date(substring(s from '^\d{1,2}/\d{1,2}/\d{2}'), 'DD/MM/YY'); end if;
  if s ~ '^\d{4}-\d{2}-\d{2}' then return substring(s from '^\d{4}-\d{2}-\d{2}')::date; end if;
  return null;
exception when others then return null;
end $$;

-- anotação "importado de ..." no histórico (kind import é do sistema; o usuário não grava esse tipo direto)
create or replace function idx_private.crm_import_note(p_tenant uuid, p_contact uuid, p_deal uuid, p_title text, p_body text, p_meta jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not idx_private.crm_can(p_tenant, 'write') then raise exception 'Sem permissão'; end if;
  insert into public.crm_timeline(tenant_id, contact_id, deal_id, kind, title, body, metadata, actor_id)
  values (p_tenant, p_contact, p_deal, 'import', left(p_title, 200), p_body, coalesce(p_meta, '{}'::jsonb), auth.uid());
end $$;
revoke all on function idx_private.crm_import_note(uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function idx_private.crm_import_note(uuid, uuid, uuid, text, text, jsonb) to authenticated;

create or replace function public.crm_import(p_tenant_id uuid, p_entity text, p_rows jsonb, p_options jsonb default '{}'::jsonb, p_file_name text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r jsonb; i int := 0;
  v_created int := 0; v_updated int := 0; v_skipped int := 0; v_errors int := 0; v_contacts_new int := 0;
  report jsonb := '[]'::jsonb;
  v_contact uuid; v_company uuid; v_phone text; v_email text; v_dup uuid; v_stage uuid; v_pipeline uuid; v_owner uuid;
  v_deal uuid; v_new_contact boolean; v_status text; v_value numeric; v_close date; v_ext text; v_note text; v_first_stage uuid;
  v_mode text := coalesce(p_options->>'on_duplicate', 'skip');            -- skip | update
  v_unknown_stage text := coalesce(p_options->>'unknown_stage', 'error'); -- error | first
  v_closed text := coalesce(p_options->>'closed_deals', 'import_open');   -- skip | import_status | import_open
  v_origin text := nullif(trim(coalesce(p_options->>'origin', '')), '');  -- ex.: "RD Station CRM"
  v_origin_tag text;
  v_import uuid;
begin
  if not idx_private.crm_can(p_tenant_id, 'write') then
    raise exception 'Sem permissão para importar.' using errcode = '42501';
  end if;
  if p_entity not in ('contacts', 'deals') then raise exception 'Entidade inválida.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Máximo de 5.000 linhas por importação.' using errcode = '22023'; end if;
  -- importar não dispara automações, cadências nem fluxos de WhatsApp (só nesta transação)
  perform set_config('idx.importing', '1', true);
  select default_pipeline_id into v_pipeline from public.crm_settings where tenant_id = p_tenant_id;
  select id into v_first_stage from public.crm_stages where pipeline_id = v_pipeline and archived_at is null order by position limit 1;
  v_origin_tag := case when v_origin is null then null
                       else 'importado-' || trim(both '-' from regexp_replace(lower(translate(v_origin, 'áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ', 'aaaaeeioooucaaaaeeiooouc')), '[^a-z0-9]+', '-', 'g')) end;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_new_contact := false;
    begin
      -- vários telefones/e-mails na mesma célula: usa o primeiro válido
      v_phone := (select x from unnest(regexp_split_to_array(coalesce(r->>'phone', ''), '\s*[,;/|]\s*')) x
                   where idx_private.normalize_phone(x) is not null limit 1);
      if v_phone is null and nullif(trim(r->>'phone'), '') is not null then
        raise exception 'telefone inválido (%)', r->>'phone';
      end if;
      v_email := (select lower(trim(x)) from unnest(regexp_split_to_array(coalesce(r->>'email', ''), '\s*[,;/|]\s*')) x
                   where lower(trim(x)) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' limit 1);
      if v_email is null and nullif(trim(r->>'email'), '') is not null then
        raise exception 'e-mail inválido (%)', r->>'email';
      end if;
      if coalesce(nullif(trim(r->>'name'), ''), v_phone, v_email, nullif(trim(r->>'title'), '')) is null then
        raise exception 'linha sem nome, telefone ou e-mail';
      end if;

      v_company := null;
      if nullif(trim(r->>'company'), '') is not null then
        select id into v_company from public.crm_companies where tenant_id = p_tenant_id and lower(name) = lower(trim(r->>'company')) limit 1;
        if v_company is null then
          insert into public.crm_companies(tenant_id, name) values (p_tenant_id, trim(r->>'company')) returning id into v_company;
        end if;
      end if;

      v_owner := null;
      if nullif(trim(r->>'owner_email'), '') is not null then
        select user_id into v_owner from public.tenant_users where tenant_id = p_tenant_id and lower(email) = lower(trim(r->>'owner_email')) and status = 'active' limit 1;
      end if;

      -- negociação: vendida/perdida no CRM de origem
      v_status := 'open';
      if p_entity = 'deals' and nullif(trim(r->>'deal_status'), '') is not null then
        v_status := case
          when lower(r->>'deal_status') ~ '(vendid|ganh|won|fechad|conclu|sucesso)' then 'won'
          when lower(r->>'deal_status') ~ '(perdid|lost|cancel|descart|recus)' then 'lost'
          else 'open' end;
        if v_status <> 'open' and v_closed = 'skip' then
          v_skipped := v_skipped + 1;
          report := report || jsonb_build_object('row', i, 'status', 'skipped', 'message',
            case when v_status = 'won' then 'negociação vendida no CRM de origem (ignorada)' else 'negociação perdida no CRM de origem (ignorada)' end);
          continue;
        end if;
        if v_closed = 'import_open' then v_status := 'open'; end if;
      end if;

      -- reimportação do mesmo arquivo: a negociação com o mesmo id de origem não entra de novo
      v_ext := nullif(trim(r->>'external_id'), '');
      if p_entity = 'deals' and v_ext is not null and exists (
        select 1 from public.crm_deals d where d.tenant_id = p_tenant_id and d.custom->>'id_origem' = v_ext
          and coalesce(d.custom->>'crm_origem', '') = coalesce(v_origin, '')) then
        v_skipped := v_skipped + 1;
        report := report || jsonb_build_object('row', i, 'status', 'skipped', 'message', 'negociação já importada antes');
        continue;
      end if;

      -- duplicidade de contato: telefone exato > e-mail exato
      v_dup := null;
      if v_phone is not null then
        select id into v_dup from public.crm_contacts where tenant_id = p_tenant_id and phone = idx_private.normalize_phone(v_phone) and merged_into_id is null;
      end if;
      if v_dup is null and v_email is not null then
        select id into v_dup from public.crm_contacts where tenant_id = p_tenant_id and email = v_email and merged_into_id is null limit 1;
      end if;

      if v_dup is not null then
        v_contact := v_dup;
        if v_mode = 'update' then
          update public.crm_contacts set
            name = coalesce(nullif(trim(r->>'name'), ''), name),
            email = coalesce(v_email, email),
            company_id = coalesce(v_company, company_id),
            job_title = coalesce(nullif(trim(r->>'job_title'), ''), job_title),
            city = coalesce(nullif(trim(r->>'city'), ''), city),
            state = coalesce(nullif(trim(r->>'state'), ''), state),
            owner_id = coalesce(v_owner, owner_id),
            tags = case when nullif(trim(r->>'tags'), '') is null and v_origin_tag is null then tags
                        else array(select distinct t from unnest(tags || string_to_array(replace(coalesce(r->>'tags', ''), ';', ','), ',') || coalesce(v_origin_tag, '')) t where trim(t) <> '') end
          where id = v_dup;
          if p_entity = 'contacts' then v_updated := v_updated + 1; end if;
        elsif p_entity = 'contacts' then
          v_skipped := v_skipped + 1;
          report := report || jsonb_build_object('row', i, 'status', 'skipped', 'message', 'duplicado (contato já existe)', 'contact_id', v_dup);
        end if;
      else
        insert into public.crm_contacts(tenant_id, name, phone, email, company_id, job_title, city, state, owner_id, tags, notes,
          source_channel, acquisition_basis, lifecycle_source, utm_source, utm_medium, utm_campaign, acquisition_campaign, created_by)
        values (p_tenant_id, coalesce(nullif(trim(r->>'name'), ''), case when p_entity = 'deals' then nullif(trim(r->>'title'), '') end),
                v_phone, v_email, v_company,
                nullif(trim(r->>'job_title'), ''), nullif(trim(r->>'city'), ''), nullif(trim(r->>'state'), ''), v_owner,
                coalesce(array(select t from (select trim(x) t, min(o) o from unnest(string_to_array(replace(coalesce(r->>'tags', ''), ';', ','), ',') || coalesce(v_origin_tag, '')) with ordinality u(x, o)
                                where trim(x) <> '' group by trim(x)) q order by o), '{}'),
                case when p_entity = 'contacts' then nullif(trim(r->>'notes'), '') end,
                coalesce(nullif(trim(r->>'source'), ''), 'import'),
                case when nullif(trim(r->>'source'), '') is not null then 'declared' else 'unknown' end, 'import',
                nullif(trim(r->>'utm_source'), ''), nullif(trim(r->>'utm_medium'), ''), nullif(trim(r->>'utm_campaign'), ''),
                nullif(trim(r->>'utm_campaign'), ''), auth.uid())
        returning id into v_contact;
        v_new_contact := true;
      end if;

      -- anotação com o que veio de fora e não tem campo próprio
      v_note := nullif(concat_ws(E'\n',
        case when v_origin is not null then 'Importado de ' || v_origin || coalesce(' (' || p_file_name || ')', '') end,
        case when nullif(trim(r->>'pipeline'), '') is not null then 'Funil de origem: ' || trim(r->>'pipeline') end,
        case when nullif(trim(r->>'stage'), '') is not null then 'Etapa de origem: ' || trim(r->>'stage') end,
        case when nullif(trim(r->>'deal_status'), '') is not null then 'Situação de origem: ' || trim(r->>'deal_status') end,
        case when nullif(trim(r->>'owner_name'), '') is not null then 'Responsável de origem: ' || trim(r->>'owner_name') end,
        case when nullif(trim(r->>'created_at'), '') is not null then 'Criado na origem em: ' || trim(r->>'created_at') end,
        case when nullif(trim(r->>'lost_reason'), '') is not null then 'Motivo da perda: ' || trim(r->>'lost_reason') end,
        nullif(trim(r->>'notes'), '')), '');

      if p_entity = 'deals' then
        v_stage := null;
        if nullif(trim(r->>'stage'), '') is not null then
          select id into v_stage from public.crm_stages where tenant_id = p_tenant_id and pipeline_id = v_pipeline
            and lower(name) = lower(trim(r->>'stage')) and archived_at is null limit 1;
          if v_stage is null and v_unknown_stage = 'error' then raise exception 'etapa "%" não existe no funil padrão', r->>'stage'; end if;
        end if;
        -- vendida/perdida: a etapa de "ganha"/"perdida" do funil (o status da negociação segue a etapa)
        if v_status in ('won', 'lost') then
          select id into v_stage from public.crm_stages where pipeline_id = v_pipeline and archived_at is null and kind = v_status
           order by position limit 1;
          if v_stage is null then raise exception 'o funil não tem etapa de venda %', case when v_status = 'won' then 'ganha' else 'perdida' end; end if;
        end if;
        v_stage := coalesce(v_stage, v_first_stage);
        v_value := idx_private.parse_money(r->>'value');
        v_close := idx_private.parse_date_br(r->>'expected_close_date');
        insert into public.crm_deals(tenant_id, pipeline_id, stage_id, title, contact_id, company_id, owner_id, value,
          expected_close_date, source_channel, attribution_basis, created_by, status, won_at, lost_at, tags, custom)
        values (p_tenant_id, v_pipeline, v_stage,
                coalesce(nullif(trim(r->>'title'), ''), coalesce(nullif(trim(r->>'name'), ''), v_phone, v_email)),
                v_contact, v_company, v_owner, greatest(coalesce(v_value, 0), 0), v_close,
                coalesce(nullif(trim(r->>'source'), ''), 'import'),
                case when nullif(trim(r->>'source'), '') is not null then 'declared' else 'unknown' end, auth.uid(),
                v_status, case when v_status = 'won' then coalesce(v_close::timestamptz, now()) end,
                case when v_status = 'lost' then coalesce(v_close::timestamptz, now()) end,
                case when v_origin_tag is not null then array[v_origin_tag] else '{}' end,
                jsonb_strip_nulls(jsonb_build_object('crm_origem', v_origin, 'id_origem', v_ext)))
        returning id into v_deal;
        if v_note is not null then
          perform idx_private.crm_import_note(p_tenant_id, v_contact, v_deal, 'Negociação importada' || coalesce(' de ' || v_origin, ''), v_note,
                  jsonb_strip_nulls(jsonb_build_object('arquivo', p_file_name, 'linha', i, 'id_origem', v_ext)));
        end if;
        v_created := v_created + 1;
      elsif v_note is not null and v_origin is not null and v_contact is not null then
        perform idx_private.crm_import_note(p_tenant_id, v_contact, null, 'Contato importado de ' || v_origin, v_note,
                jsonb_build_object('arquivo', p_file_name, 'linha', i));
      end if;
      -- só conta depois que a linha inteira foi gravada
      if v_new_contact then
        v_contacts_new := v_contacts_new + 1;
        if p_entity = 'contacts' then v_created := v_created + 1; end if;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      report := report || jsonb_build_object('row', i, 'status', 'error', 'message', sqlerrm);
    end;
  end loop;

  insert into public.crm_imports(tenant_id, entity, file_name, total_rows, created_rows, updated_rows, skipped_rows, error_rows, report, options, created_by)
  values (p_tenant_id, p_entity, p_file_name, i, v_created, v_updated, v_skipped, v_errors, report, p_options, auth.uid())
  returning id into v_import;

  return jsonb_build_object('import_id', v_import, 'total', i, 'created', v_created, 'updated', v_updated,
                            'skipped', v_skipped, 'errors', v_errors, 'contacts_created', v_contacts_new, 'report', report);
end;
$$;
grant execute on function public.crm_import(uuid, text, jsonb, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
