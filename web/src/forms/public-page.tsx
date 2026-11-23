// Página pública do formulário: croengine.pro/f/<endereço>. Não precisa de login.
// Registra a visita (UTM, fbclid, gclid, de onde veio, aparelho), cada passo e cada clique, e envia para o CRM.
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { FormRenderer } from "./renderer";
import { normalizeContent, type PublicForm } from "./types";
import "./forms.css";

const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const cookie = (name: string) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.split("=")[1];

function trackingMeta() {
  const u = new URL(window.location.href);
  const p = (k: string) => u.searchParams.get(k) || undefined;
  const fbclid = p("fbclid");
  return {
    utm_source: p("utm_source"), utm_medium: p("utm_medium"), utm_campaign: p("utm_campaign"), utm_content: p("utm_content"), utm_term: p("utm_term"),
    fbclid, gclid: p("gclid"), ttclid: p("ttclid"),
    fbp: cookie("_fbp"), fbc: cookie("_fbc") || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined),
    referrer: document.referrer || undefined, landing_url: window.location.href,
  };
}

declare global { interface Window { fbq?: (...a: unknown[]) => void; _fbq?: unknown } }
function loadPixel(id: string) {
  if (!/^\d{6,20}$/.test(id) || window.fbq) return;
  /* eslint-disable */
  (function (f: any, b: Document, e: string, v: string) {
    if (f.fbq) return; const n: any = (f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); });
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];
    const t = b.createElement(e) as HTMLScriptElement; t.async = true; t.src = v; const s = b.getElementsByTagName(e)[0]; s.parentNode!.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  /* eslint-enable */
  const fbq = (window as Window).fbq as ((...a: unknown[]) => void) | undefined;
  fbq?.("init", id);
  fbq?.("track", "PageView");
}

export function PublicFormPage({ slug }: { slug: string }) {
  const [form, setForm] = useState<PublicForm | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const session = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    sb.rpc("form_public", { p_slug: slug }).then(({ data, error }) => {
      if (error) { setState("error"); return; }
      if (!data) { setState("missing"); return; }
      const f = data as PublicForm;
      f.content = normalizeContent(f.content, f.style, f.brand?.name ?? "");
      if (f.brand?.color && !f.content.theme.color) f.content.theme.color = f.brand.color;
      setForm(f);
      setState("ready");
      // o nome interno do formulário não aparece para o cliente
      const plain = (t?: string) => (t ?? "").replace(/\*\*/g, "").trim();
      document.title = [plain(f.content.header.name) || f.brand?.name, plain(f.content.intro.eyebrow) || plain(f.content.intro.badge)].filter(Boolean).join(" · ") || "Formulário";
      const icon = f.content.header.logo_url || f.brand?.logo_url || f.content.header.avatar_url;
      if (icon) {
        document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
        const l = document.createElement("link"); l.rel = "icon"; l.href = icon; document.head.appendChild(l);
      }
      const desc = plain(f.content.intro.subtitle) || plain(f.content.intro.title);
      let m = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
      if (!m) { m = document.createElement("meta"); m.name = "description"; document.head.appendChild(m); }
      m.content = desc.slice(0, 160);
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", f.content.theme.color || "#ffffff");
      if (f.pixel_id) loadPixel(f.pixel_id);
      const key = `ff:${slug}`;
      const saved = sessionStorage.getItem(key);
      void track("view", 0, {}, saved);
    });
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // eventos em fila, na ordem, sem travar a tela; a primeira chamada cria a visita
  function track(event: string, step: number, data: Record<string, unknown> = {}, reuse?: string | null) {
    queue.current = queue.current.then(async () => {
      const { data: id } = await sb.rpc("form_track", {
        p_slug: slug, p_session: session.current ?? reuse ?? null, p_event: event, p_step: step, p_data: data,
        p_meta: session.current ? {} : trackingMeta(),
      });
      if (id && !session.current) { session.current = id as string; sessionStorage.setItem(`ff:${slug}`, id as string); }
    }).catch(() => undefined);
    return queue.current;
  }

  if (state === "loading") return <div className="ff ff-loading" style={{ display: "grid", placeItems: "center" }}><span style={{ color: "#94a3b8" }}>Carregando…</span></div>;
  if (state !== "ready" || !form) {
    return (
      <div className="ff" style={{ display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
        <div><h2 style={{ fontFamily: "Inter, sans-serif" }}>{state === "missing" ? "Formulário indisponível" : "Não foi possível abrir o formulário"}</h2>
          <p style={{ color: "#64748b" }}>{state === "missing" ? "Este link não está mais ativo." : "Verifique a internet e recarregue a página."}</p></div>
      </div>
    );
  }
  return (
    <FormRenderer
      form={form}
      onTrack={(e, s, d) => { void track(e, s, d); }}
      onSubmit={async (answers, contact) => {
        await queue.current;
        if (!session.current) await track("start", 1);
        const { error } = await sb.rpc("form_submit", { p_slug: slug, p_session: session.current, p_answers: answers, p_contact: contact });
        if (error) throw new Error(error.message.replace(/^.*?: /, ""));
        sessionStorage.removeItem(`ff:${slug}`);
        window.fbq?.("track", "Lead", {}, { eventID: session.current });
      }}
    />
  );
}
