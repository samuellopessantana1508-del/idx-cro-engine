// IDX CRM — service worker: guarda a sessão do usuário (nunca chaves de
// administrador) e faz as chamadas ao Supabase em nome da página do WhatsApp.
// Todas as leituras/gravações passam pelas regras de acesso (RLS) do CRM.
importScripts("config.js");
const { SUPABASE_URL, SUPABASE_ANON_KEY } = self.IDX_CONFIG;

const store = {
  get: (k) => chrome.storage.local.get(k).then((r) => r[k] ?? null),
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  del: (k) => chrome.storage.local.remove(k),
};

async function authRequest(grant, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || "Não foi possível entrar");
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    email: data.user?.email ?? null,
    user_id: data.user?.id ?? null,
  };
  await store.set("session", session);
  return session;
}

let refreshing = null;
async function validSession() {
  const s = await store.get("session");
  if (!s) return null;
  if (s.expires_at - 60 > Date.now() / 1000) return s;
  refreshing ??= authRequest("refresh_token", { refresh_token: s.refresh_token })
    .catch(async () => { await store.del("session"); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function api({ path, method = "GET", body, headers = {} }) {
  const s = await validSession();
  if (!s) return { ok: false, status: 401, data: { error: "Entre com seu usuário do CRO Engine" } };
  // só fala com o próprio Supabase do CRM
  if (!/^\/(rest|functions)\/v1\//.test(path)) return { ok: false, status: 400, data: { error: "Caminho não permitido" } };
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${s.access_token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "login") {
        const s = await authRequest("password", { email: msg.email, password: msg.password });
        reply({ ok: true, email: s.email, user_id: s.user_id });
      } else if (msg.type === "logout") {
        await store.del("session"); await store.del("tenant");
        reply({ ok: true });
      } else if (msg.type === "session") {
        const s = await validSession();
        reply({ ok: true, email: s?.email ?? null, user_id: s?.user_id ?? null, tenant: await store.get("tenant") });
      } else if (msg.type === "setTenant") {
        await store.set("tenant", msg.tenant);
        reply({ ok: true });
      } else if (msg.type === "api") {
        reply(await api(msg));
      } else {
        reply({ ok: false, data: { error: "Mensagem desconhecida" } });
      }
    } catch (e) {
      reply({ ok: false, data: { error: e instanceof Error ? e.message : String(e) } });
    }
  })();
  return true; // resposta assíncrona
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: "https://web.whatsapp.com/" }));
