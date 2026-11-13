-- Resposta automática não é resposta de verdade.
-- Muitas empresas (ex.: escolas) têm mensagem de boas-vindas automática no WhatsApp Business:
-- ela chega 1–5 s depois do disparo. Antes, isso marcava o destinatário como "respondeu",
-- tirava ele dos follow-ups e criava negociação em "Novo lead".
-- Agora, uma resposta que chega até 15 s depois do envio é ignorada para esses efeitos
-- (a mensagem continua na caixa de entrada normalmente). A próxima mensagem de verdade marca a resposta.

create or replace function idx_private.wa_ignore_autoreply()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.replied_at is null and new.replied_at is not null and new.sent_at is not null
     and new.replied_at < new.sent_at + interval '15 seconds' then
    new.replied_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists wa_ignore_autoreply on public.wa_campaign_recipients;
create trigger wa_ignore_autoreply
  before update of replied_at on public.wa_campaign_recipients
  for each row execute function idx_private.wa_ignore_autoreply();
