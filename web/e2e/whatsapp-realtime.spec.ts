import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

// Teste da aba WhatsApp em tempo real com o Supabase simulado (REST + Realtime).
// Rode com um build apontando para o mock:
//   VITE_SUPABASE_URL=https://mock.supabase.co VITE_SUPABASE_ANON_KEY=anon npm run build
//   E2E_MOCK_SUPABASE=1 npx playwright test e2e/whatsapp-realtime.spec.ts
test.skip(!process.env.E2E_MOCK_SUPABASE, "Requer build com VITE_SUPABASE_URL=https://mock.supabase.co e E2E_MOCK_SUPABASE=1.");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const now = Date.now();
const iso = (offsetSeconds: number) => new Date(now + offsetSeconds * 1000).toISOString();

type Row = Record<string, any>;

function makeDb() {
  const contacts: Row[] = [
    { id: "k1", tenant_id: TENANT_A, instance_id: "i1", wa_id: "5564999990001", phone: "5564999990001", push_name: "Arthur IDX", is_business: false, created_at: iso(-3600), updated_at: iso(-3600) },
    { id: "k2", tenant_id: TENANT_A, instance_id: "i1", wa_id: "5564999990002", phone: "5564999990002", push_name: "Maria Farmácia", is_business: false, created_at: iso(0), updated_at: iso(0) },
  ];
  const conversations: Row[] = [
    { id: "c1", tenant_id: TENANT_A, instance_id: "i1", contact_id: "k1", status: "active", last_message_at: iso(-60), unread_count: 0, ai_summary: null, ai_analyzed_at: null, created_at: iso(-3600), updated_at: iso(-60) },
  ];
  const messages: Row[] = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`, tenant_id: TENANT_A, conversation_id: "c1", direction: i % 2 ? "outbound" : "inbound",
    content_type: "text", body: `Mensagem antiga ${i}`, timestamp: iso(-600 + i * 10), status: "read", created_at: iso(-600 + i * 10),
  }));
  return { contacts, conversations, messages, markRead: [] as string[] };
}

function matches(row: Row, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const [op, ...rest] = raw.split(".");
    const value = rest.join(".");
    if (op === "eq" && String(row[key]) !== value) return false;
    if (op === "gte" && !(String(row[key]) >= value)) return false;
  }
  return true;
}

async function mockSupabase(page: Page, db: ReturnType<typeof makeDb>) {
  const session = {
    access_token: "test-access-token",
    refresh_token: "test-refresh",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(now / 1000) + 3600,
    user: { id: "user-a", email: "dono@sanmar.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: iso(-86400) },
  };
  await page.addInitScript((value) => localStorage.setItem("sb-mock-auth-token", JSON.stringify(value)), session);

  await page.route("https://mock.supabase.co/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const accept = req.headers()["accept"] ?? "";
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.startsWith("/auth/v1/")) return reply(session.user);
    if (url.pathname === "/functions/v1/tenant-admin") {
      return reply({
        ok: true,
        platform_role: null,
        tenant_summaries: [],
        tenants: [{ id: TENANT_A, slug: "rede-sanmar", name: "Rede Sanmar", whatsapp_number: "5564999999999", status: "active", default_message_template: "" }],
      });
    }
    if (url.pathname.startsWith("/functions/v1/")) return reply({ ok: true });
    if (url.pathname === "/rest/v1/rpc/mark_whatsapp_conversation_read") {
      const { p_conversation_id } = JSON.parse(req.postData() ?? "{}");
      db.markRead.push(p_conversation_id);
      const conv = db.conversations.find((c) => c.id === p_conversation_id);
      if (conv) conv.unread_count = 0;
      return route.fulfill({ status: 204, body: "" });
    }

    const table = url.pathname.replace("/rest/v1/", "");
    let rows: Row[] = [];
    if (table === "tenant_users") rows = [{ id: "tu", tenant_id: TENANT_A, user_id: "user-a", email: "dono@sanmar.com", role: "owner", status: "active", created_at: iso(-86400) }];
    if (table === "whatsapp_conversations") {
      rows = db.conversations.filter((c) => matches(c, url)).map((c) => ({ ...c, contact: db.contacts.find((k) => k.id === c.contact_id) }));
      rows.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
    }
    if (table === "whatsapp_messages") {
      rows = db.messages.filter((m) => matches(m, url));
      const desc = url.searchParams.get("order")?.includes("desc");
      rows.sort((a, b) => (desc ? b.timestamp.localeCompare(a.timestamp) : a.timestamp.localeCompare(b.timestamp)));
      const limit = Number(url.searchParams.get("limit") ?? 0);
      if (limit) rows = rows.slice(0, limit);
    }
    if (accept.includes("vnd.pgrst.object")) {
      return rows.length ? reply(rows[0]) : reply({ code: "PGRST116", details: "0 rows", message: "no rows" }, 406);
    }
    return reply(rows);
  });
}

// Servidor Realtime (Phoenix, vsn 1.0.0) simulado.
class RealtimeServer {
  sockets: WebSocketRoute[] = [];
  joins: { topic: string; bindings: Row[] }[] = [];
  private topic = "";
  private bindings: Row[] = [];
  accept = true;

  async attach(page: Page) {
    await page.routeWebSocket(/mock\.supabase\.co\/realtime/, (ws) => {
      if (!this.accept) {
        ws.close({ code: 1011, reason: "unavailable" });
        return;
      }
      this.sockets.push(ws);
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.topic === "phoenix" && msg.event === "heartbeat") {
          ws.send(JSON.stringify({ topic: "phoenix", event: "phx_reply", ref: msg.ref, payload: { status: "ok", response: {} } }));
          return;
        }
        if (msg.event === "phx_join") {
          const bindings = (msg.payload?.config?.postgres_changes ?? []).map((b: Row, i: number) => ({ ...b, id: i + 1 }));
          this.topic = msg.topic;
          this.bindings = bindings;
          this.joins.push({ topic: msg.topic, bindings });
          ws.send(JSON.stringify({ topic: msg.topic, event: "phx_reply", ref: msg.ref, join_ref: msg.join_ref, payload: { status: "ok", response: { postgres_changes: bindings } } }));
          return;
        }
        if (msg.event === "phx_leave") {
          ws.send(JSON.stringify({ topic: msg.topic, event: "phx_reply", ref: msg.ref, payload: { status: "ok", response: {} } }));
        }
      });
    });
  }

  emit(table: string, type: "INSERT" | "UPDATE", record: Row) {
    const ids = this.bindings
      .filter((b) => b.table === table && (b.event === "*" || b.event === type))
      .map((b) => b.id);
    const ws = this.sockets[this.sockets.length - 1];
    ws.send(JSON.stringify({
      topic: this.topic,
      event: "postgres_changes",
      ref: null,
      payload: { ids, data: { schema: "public", table, commit_timestamp: new Date().toISOString(), type, columns: [], record, old_record: {}, errors: null } },
    }));
  }

  drop() {
    const ws = this.sockets[this.sockets.length - 1];
    ws.close({ code: 1006, reason: "network" });
  }
}

test("WhatsApp atualiza sem F5: conversa nova, mensagens, contador, análise, reconexão e isolamento", async ({ page }) => {
  const db = makeDb();
  const realtime = new RealtimeServer();
  await mockSupabase(page, db);
  await realtime.attach(page);

  await page.goto("/rede-sanmar?section=whatsapp");
  await expect(page.locator(".wa-contact-item").first()).toContainText("Arthur IDX");
  await expect(page.locator(".wa-sync-status")).toContainText("Ao vivo");

  // Assinatura restrita à empresa atual.
  const join = realtime.joins[realtime.joins.length - 1];
  expect(join.bindings.length).toBeGreaterThan(0);
  for (const binding of join.bindings) expect(binding.filter).toBe(`tenant_id=eq.${TENANT_A}`);

  // 1) Cliente novo manda mensagem: conversa aparece no topo, com prévia e contador.
  db.conversations.push({ id: "c2", tenant_id: TENANT_A, instance_id: "i1", contact_id: "k2", status: "active", last_message_at: iso(5), unread_count: 1, created_at: iso(5), updated_at: iso(5) });
  const m2 = { id: "new-1", tenant_id: TENANT_A, conversation_id: "c2", direction: "inbound", content_type: "text", body: "Vocês têm dipirona?", timestamp: iso(5), status: "sent", created_at: iso(5) };
  db.messages.push(m2);
  realtime.emit("whatsapp_messages", "INSERT", m2);
  const first = page.locator(".wa-contact-item").first();
  await expect(first).toContainText("Maria Farmácia");
  await expect(first).toContainText("Vocês têm dipirona?");
  await expect(first).toHaveClass(/unread/);
  await expect(page.locator(".nav-button .nav-badge").first()).toHaveText("1");

  // 2) Empresa B: evento de outra empresa nunca aparece.
  realtime.emit("whatsapp_messages", "INSERT", { id: "leak", tenant_id: TENANT_B, conversation_id: "cb", direction: "inbound", content_type: "text", body: "Mensagem da outra empresa", timestamp: iso(6), status: "sent", created_at: iso(6) });
  await page.waitForTimeout(300);
  await expect(page.getByText("Mensagem da outra empresa")).toHaveCount(0);
  expect(db.conversations.some((c) => c.id === "cb")).toBe(false);

  // 3) Abre a conversa do Arthur: mensagem recebida aparece e a conversa fica lida.
  await page.locator(".wa-contact-item", { hasText: "Arthur IDX" }).click();
  await expect(page.locator(".wa-thread-messages")).toContainText("Mensagem antiga 39");
  const inbound = { id: "new-2", tenant_id: TENANT_A, conversation_id: "c1", direction: "inbound", content_type: "text", body: "Quero comprar", timestamp: iso(10), status: "sent", created_at: iso(10) };
  db.messages.push(inbound);
  realtime.emit("whatsapp_messages", "INSERT", inbound);
  await expect(page.locator(".wa-thread-messages")).toContainText("Quero comprar");
  await expect.poll(() => db.markRead.includes("c1")).toBe(true);

  // 4) Mensagem enviada pela empresa também aparece, com prévia "Você:".
  const outbound = { id: "new-3", tenant_id: TENANT_A, conversation_id: "c1", direction: "outbound", content_type: "text", body: "Qual produto você procura?", timestamp: iso(12), status: "sent", created_at: iso(12) };
  db.messages.push(outbound);
  realtime.emit("whatsapp_messages", "INSERT", outbound);
  await expect(page.locator(".wa-thread-messages")).toContainText("Qual produto você procura?");
  await expect(page.locator(".wa-contact-item", { hasText: "Arthur IDX" })).toContainText("Você: Qual produto você procura?");

  // 5) Lendo mensagens antigas: a tela não pula; aparece o aviso de novas mensagens.
  await page.locator(".wa-thread-messages").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  const before = await page.locator(".wa-thread-messages").evaluate((el) => el.scrollTop);
  const later = { id: "new-4", tenant_id: TENANT_A, conversation_id: "c1", direction: "inbound", content_type: "text", body: "Ainda está aí?", timestamp: iso(14), status: "sent", created_at: iso(14) };
  db.messages.push(later);
  realtime.emit("whatsapp_messages", "INSERT", later);
  await expect(page.locator(".wa-new-below")).toBeVisible();
  expect(await page.locator(".wa-thread-messages").evaluate((el) => el.scrollTop)).toBe(before);
  await page.locator(".wa-new-below").click();
  await expect(page.locator(".wa-new-below")).toHaveCount(0);

  // 6) Análise da IA concluída: o painel da conversa atualiza sozinho.
  realtime.emit("conversation_insights", "INSERT", {
    id: "ins1", tenant_id: TENANT_A, conversation_id: "c1",
    summary: "Arthur IDX demonstrou interesse em comprar, mas ainda não informou qual produto ou serviço deseja. Nenhuma objeção foi identificada.",
    intent: "Intenção forte de compra", sentiment: "neutral", purchase_probability: 0.5, messages_analyzed_count: 2,
    products_of_interest: [], objections: [], updated_at: iso(15),
  });
  await page.locator(".wa-ai-panel-toggle").click();
  await expect(page.getByText("Arthur IDX demonstrou interesse em comprar")).toBeVisible();

  // 7) Queda de conexão: mensagem chega durante a queda e aparece após reconectar.
  const joinsBefore = realtime.joins.length;
  const during = { id: "new-5", tenant_id: TENANT_A, conversation_id: "c1", direction: "inbound", content_type: "text", body: "Mandei durante a queda", timestamp: iso(20), status: "sent", created_at: iso(20) };
  realtime.drop();
  db.messages.push(during);
  await expect.poll(() => realtime.joins.length, { timeout: 20000 }).toBeGreaterThan(joinsBefore);
  await expect(page.locator(".wa-sync-status")).toContainText("Ao vivo", { timeout: 20000 });
  await expect(page.locator(".wa-thread-messages")).toContainText("Mandei durante a queda", { timeout: 20000 });
});

test("sem Realtime: polling de reserva mostra mensagens novas", async ({ page }) => {
  test.setTimeout(90000);
  const db = makeDb();
  const realtime = new RealtimeServer();
  realtime.accept = false;
  await mockSupabase(page, db);
  await realtime.attach(page);

  await page.goto("/rede-sanmar?section=whatsapp");
  await expect(page.locator(".wa-contact-item").first()).toContainText("Arthur IDX");
  await expect(page.locator(".wa-sync-status")).not.toContainText("Ao vivo");

  db.conversations.push({ id: "c2", tenant_id: TENANT_A, instance_id: "i1", contact_id: "k2", status: "active", last_message_at: iso(5), unread_count: 1, created_at: iso(5), updated_at: iso(5) });
  db.messages.push({ id: "poll-1", tenant_id: TENANT_A, conversation_id: "c2", direction: "inbound", content_type: "text", body: "Chegou pelo polling", timestamp: iso(5), status: "sent", created_at: iso(5) });
  await expect(page.locator(".wa-contact-item").first()).toContainText("Maria Farmácia", { timeout: 70000 });
  await expect(page.locator(".wa-contact-item").first()).toContainText("Chegou pelo polling");
});
