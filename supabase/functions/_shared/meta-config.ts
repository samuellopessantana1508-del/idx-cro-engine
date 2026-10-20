// URL pública do painel e URI de retorno do Facebook Login.
//
// O painel saiu de idxparasuaempresa.com.br para cro.sanmarfidelize.com. Se um
// secret antigo (APP_URL / META_REDIRECT_URI) ainda apontar para o domínio
// desativado, ele é ignorado: mandar o usuário para lá termina em 404 e o
// Facebook recusa a troca do código.
export const DEFAULT_APP_URL = "https://cro.sanmarfidelize.com";
export const META_CALLBACK_PATH = "/meta-oauth-callback.html";

const RETIRED_HOSTS = new Set(["idxparasuaempresa.com.br", "www.idxparasuaempresa.com.br"]);

function usableUrl(value: string | undefined | null): URL | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    if (RETIRED_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url;
  } catch {
    return null;
  }
}

export function publicAppUrl(): string {
  const url = usableUrl(Deno.env.get("APP_URL"));
  return (url ? url.origin : DEFAULT_APP_URL).replace(/\/+$/, "");
}

// Precisa ser idêntica nas duas pontas: no link de autorização e na troca do
// código por token. E precisa estar cadastrada em "Valid OAuth Redirect URIs".
export function metaRedirectUri(): string {
  const url = usableUrl(Deno.env.get("META_REDIRECT_URI"));
  return url ? url.toString() : `${publicAppUrl()}${META_CALLBACK_PATH}`;
}

// Só aceita voltar para o próprio painel (evita redirecionar para outro site).
export function safeReturnUrl(candidate: unknown, fallbackPath = "/?section=integrations"): URL {
  const app = new URL(publicAppUrl());
  try {
    const url = new URL(String(candidate ?? ""), app);
    if (url.origin === app.origin) return url;
  } catch {
    // cai no padrão
  }
  return new URL(fallbackPath, app);
}

// Token do Facebook Login (contas de anúncio, campanhas, públicos). Quem não
// conectou pelo Facebook continua usando o token salvo manualmente.
export function adsAccessToken(creds: Record<string, any> | null | undefined): string | null {
  return creds?.ads_access_token || creds?.access_token || null;
}
