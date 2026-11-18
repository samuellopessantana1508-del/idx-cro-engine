-- Disparos pelo QR Code (Evolution/Baileys): intervalo mínimo entre mensagens passa de 15 s para 5 s,
-- a pedido do dono da conta. Quem escolhe intervalos curtos assume o risco de bloqueio do próprio número.
do $$
declare r record; v_def text; v_new text;
begin
  for r in
    select conname from pg_constraint
     where conrelid = 'public.wa_campaigns'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ~ '(min|max)_delay_sec >= 15'
  loop
    execute format('alter table public.wa_campaigns drop constraint %I', r.conname);
  end loop;

  v_def := pg_get_functiondef('public.wa_campaign_save(uuid, uuid, text, text[], int, int, int, int, int, boolean)'::regprocedure);
  v_new := replace(v_def, $q$if p_min_delay < 15 then raise exception 'O intervalo mínimo é de 15 segundos'; end if;$q$,
                          $q$if p_min_delay < 5 then raise exception 'O intervalo mínimo é de 5 segundos'; end if;$q$);
  if v_new = v_def and position('mínimo é de 5 segundos' in v_def) = 0 then
    raise exception 'wa_campaign_save: trecho do intervalo mínimo não encontrado';
  end if;
  execute v_new;
end $$;

alter table public.wa_campaigns drop constraint if exists wa_campaigns_min_delay_5s;
alter table public.wa_campaigns drop constraint if exists wa_campaigns_max_delay_5s;
alter table public.wa_campaigns add constraint wa_campaigns_min_delay_5s check (min_delay_sec >= 5);
alter table public.wa_campaigns add constraint wa_campaigns_max_delay_5s check (max_delay_sec >= 5);
