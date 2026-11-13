-- Follow-ups de disparo: quem não respondeu recebe até 10 mensagens de acompanhamento,
-- cada uma X horas depois do envio do disparo (ex.: D0+4h, D1, D3, D5, D7).
-- Para no primeiro "respondeu", em quem pediu SAIR e quando o disparo é cancelado/pausado.
-- Na API oficial cada passo usa um modelo aprovado (fora da janela de 24 h só modelo é permitido).

alter table public.wa_campaigns add column if not exists followups jsonb not null default '[]'::jsonb;
alter table public.wa_campaign_recipients add column if not exists followup_step smallint not null default 0;
alter table public.wa_campaign_recipients add column if not exists followup_at timestamptz;

create index if not exists wa_recipients_followup_idx on public.wa_campaign_recipients (campaign_id, sent_at)
  where status = 'sent' and replied_at is null;

alter table public.wa_outbox drop constraint if exists wa_outbox_source_check;
alter table public.wa_outbox add constraint wa_outbox_source_check check (source in ('manual', 'campaign', 'flow', 'followup'));

-- a fila envia follow-ups junto com as conversas (e tenta de novo se falhar)
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.wa_gw_claim(text, uuid)'::regprocedure);
  v_new := replace(v_def, $q$status = 'queued' and source in ('manual', 'flow')$q$, $q$status = 'queued' and source in ('manual', 'flow', 'followup')$q$);
  if v_new = v_def and position($q$'followup'$q$ in v_def) = 0 then raise exception 'wa_gw_claim: trecho da fila não encontrado'; end if;
  execute v_new;

  v_def := pg_get_functiondef('public.wa_gw_result(text, uuid, boolean, text, text, text, boolean, boolean)'::regprocedure);
  v_new := replace(v_def, $q$if o.source in ('manual', 'flow') then$q$, $q$if o.source in ('manual', 'flow', 'followup') then$q$);
  if v_new = v_def and position($q$'followup'$q$ in v_def) = 0 then raise exception 'wa_gw_result: trecho de nova tentativa não encontrado'; end if;
  execute v_new;
end $$;

-- Configura os follow-ups do disparo (pode mudar a qualquer momento; vale para os próximos passos)
create or replace function public.wa_campaign_set_followups(p_campaign_id uuid, p_followups jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.wa_campaigns;
  s jsonb;
  t public.wa_templates;
  v_out jsonb := '[]'::jsonb;
  v_hours numeric;
  v_prev numeric := 0;
  v_text text;
  v_tpl jsonb;
begin
  select * into c from public.wa_campaigns where id = p_campaign_id;
  if c.id is null or not idx_private.crm_can(c.tenant_id, 'write') then raise exception 'Disparo não encontrado'; end if;
  if jsonb_typeof(coalesce(p_followups, '[]'::jsonb)) <> 'array' then raise exception 'Follow-ups inválidos'; end if;
  if jsonb_array_length(coalesce(p_followups, '[]'::jsonb)) > 10 then raise exception 'No máximo 10 follow-ups'; end if;

  for s in select value from jsonb_array_elements(coalesce(p_followups, '[]'::jsonb)) loop
    v_hours := nullif(s->>'after_hours', '')::numeric;
    if v_hours is null or v_hours <= 0 or v_hours > 720 then raise exception 'Cada follow-up precisa de um prazo entre 1 hora e 30 dias'; end if;
    if v_hours <= v_prev then raise exception 'Os follow-ups precisam estar em ordem de prazo (ex.: 4 h, 1 dia, 3 dias…)'; end if;
    v_prev := v_hours;
    v_text := nullif(trim(coalesce(s->>'text', '')), '');
    v_tpl := null;
    if s->'template' is not null and jsonb_typeof(s->'template') = 'object' then
      t := idx_private.wa_template_check(c.tenant_id, s->'template');
      v_tpl := jsonb_build_object('name', t.name, 'language', t.language,
                                  'params', coalesce(s->'template'->'params', '[]'::jsonb), 'preview', t.body_text);
    end if;
    if v_text is null and v_tpl is null then raise exception 'Cada follow-up precisa de uma mensagem ou de um modelo aprovado'; end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'after_hours', v_hours, 'label', nullif(trim(coalesce(s->>'label', '')), ''), 'text', left(v_text, 3500), 'template', v_tpl)));
  end loop;

  update public.wa_campaigns set followups = v_out, updated_at = now() where id = c.id;
  return v_out;
end $$;
grant execute on function public.wa_campaign_set_followups(uuid, jsonb) to authenticated;

-- Coloca na fila os follow-ups vencidos (chamado pelo motor de automações a cada ~30 s)
create or replace function public.wa_followups_tick(p_limit int default 200)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare
  x record;
  s jsonb;
  v_n int := 0;
  v_inst uuid;
  v_provider text;
  v_tz text;
  v_hour int;
  v_body text;
  v_tpl jsonb;
  v_params jsonb;
  v_p text;
  v_total int;
begin
  for x in
    select r.id, r.tenant_id, r.phone, r.name, r.vars, r.followup_step, r.sent_at,
           c.id as campaign_id, c.followups, c.start_hour, c.end_hour, c.opt_out_footer, c.started_by, c.created_by
      from public.wa_campaign_recipients r
      join public.wa_campaigns c on c.id = r.campaign_id
     where c.status in ('running', 'completed')
       and jsonb_array_length(c.followups) > 0
       and r.status = 'sent' and r.replied_at is null and r.sent_at is not null
       and r.sent_at > now() - interval '31 days'
       and r.followup_step < jsonb_array_length(c.followups)
       and r.sent_at + make_interval(secs => ((c.followups -> r.followup_step ->> 'after_hours')::numeric * 3600)::int) <= now()
       and (r.followup_at is null or r.followup_at < now() - interval '2 hours')   -- nunca dois seguidos
     order by r.sent_at
     limit greatest(1, least(p_limit, 1000))
     for update of r skip locked
  loop
    v_total := jsonb_array_length(x.followups);
    -- pediu SAIR: encerra a sequência
    if exists (select 1 from public.wa_optouts o where o.tenant_id = x.tenant_id
                and (o.phone = x.phone or idx_private.phone_match_key(o.phone) = idx_private.phone_match_key(x.phone))) then
      update public.wa_campaign_recipients set followup_step = v_total where id = x.id;
      continue;
    end if;
    -- respeita o horário de envio do disparo
    v_tz := idx_private.crm_tenant_tz(x.tenant_id);
    v_hour := extract(hour from now() at time zone v_tz)::int;
    if v_hour < x.start_hour or v_hour >= x.end_hour then continue; end if;

    v_inst := idx_private.wa_active_instance(x.tenant_id);
    if v_inst is null then continue; end if;
    v_provider := idx_private.wa_active_provider(x.tenant_id);
    s := x.followups -> x.followup_step;
    v_tpl := null;

    if v_provider = 'cloud_api' then
      if s->'template' is null then
        -- API oficial sem modelo: fora da janela de 24 h a Meta não deixa enviar texto livre; pula o passo
        update public.wa_campaign_recipients set followup_step = followup_step + 1, followup_at = now(),
               error = left('Follow-up ' || (x.followup_step + 1) || ' sem modelo aprovado (API oficial)', 300)
         where id = x.id;
        continue;
      end if;
      v_params := '[]'::jsonb;
      for v_p in select jsonb_array_elements_text(coalesce(s->'template'->'params', '[]'::jsonb)) loop
        v_params := v_params || to_jsonb(coalesce(nullif(trim(idx_private.wa_render(v_p, x.name, x.vars)), ''), '-'));
      end loop;
      v_tpl := jsonb_build_object('name', s->'template'->>'name', 'language', s->'template'->>'language', 'params', v_params);
      v_body := coalesce(s->'template'->>'preview', '[modelo ' || (s->'template'->>'name') || ']');
      for i in 0 .. jsonb_array_length(v_params) - 1 loop
        v_body := replace(v_body, '{{' || (i + 1) || '}}', v_params->>i);
      end loop;
    else
      v_body := idx_private.wa_render(coalesce(s->>'text', s->'template'->>'preview'), x.name, x.vars);
      if coalesce(trim(v_body), '') = '' then
        update public.wa_campaign_recipients set followup_step = followup_step + 1, followup_at = now() where id = x.id;
        continue;
      end if;
      if x.opt_out_footer then v_body := idx_private.wa_with_footer(v_body); end if;
    end if;

    insert into public.wa_outbox (tenant_id, instance_id, phone, body, source, campaign_id, status, created_by, template)
    values (x.tenant_id, v_inst, x.phone, left(v_body, 4096), 'followup', x.campaign_id, 'queued',
            coalesce(x.started_by, x.created_by), v_tpl);
    update public.wa_campaign_recipients set followup_step = followup_step + 1, followup_at = now() where id = x.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.wa_followups_tick(int) from public, anon, authenticated;
grant execute on function public.wa_followups_tick(int) to service_role;
