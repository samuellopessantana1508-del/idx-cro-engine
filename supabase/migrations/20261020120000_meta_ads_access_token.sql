-- Token do Facebook Login separado do Token CAPI.
--
-- Antes, "Conectar Facebook" gravava o token do usuário em access_token, o
-- mesmo campo do Token CAPI colado do Events Manager. O token do usuário vence
-- em ~60 dias e pode não ter acesso ao Pixel: o CAPI parava sem aviso.
--
-- Agora:
--   access_token      -> Token CAPI (Pixel). Usado por go, convert, crm, capi-health.
--   ads_access_token  -> token do Facebook Login. Usado por meta-assets,
--                        meta-insights e públicos. Vazio = usa access_token.
alter table public.tenant_meta_credentials
  add column if not exists ads_access_token text;
