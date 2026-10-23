import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/20261023120000_whatsapp_realtime.sql", import.meta.url), "utf8");
const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("migration publica as tabelas do WhatsApp no Realtime de forma idempotente", () => {
  for (const table of ["whatsapp_messages", "whatsapp_conversations", "whatsapp_contacts", "conversation_insights", "sale_signals"]) {
    assert.match(migration, new RegExp(`'${table}'`));
  }
  assert.match(migration, /pg_publication_tables/);
  assert.doesNotMatch(migration, /'whatsapp_instances'/, "instâncias ficam fora da publicação");
});

test("marcar como lida respeita a empresa do usuário", () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /idx_private\.has_tenant_role\(tenant_id\)/);
  assert.match(migration, /revoke all on function public\.mark_whatsapp_conversation_read\(uuid\) from public/i);
});

test("todas as assinaturas Realtime do painel filtram por tenant_id", () => {
  const bindings = [...app.matchAll(/\.on\(\s*"postgres_changes",\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(bindings.length >= 6);
  for (const binding of bindings) assert.match(binding, /filter: tenantFilter/);
  assert.match(app, /const tenantFilter = `tenant_id=eq\.\$\{tenant\.id\}`/);
});

test("painel tem reconexão, polling de reserva e ressincronização", () => {
  assert.match(app, /CHANNEL_ERROR/);
  assert.match(app, /waChannelAttempt/);
  assert.match(app, /resyncWhatsapp/);
  assert.match(app, /visibilitychange/);
});
