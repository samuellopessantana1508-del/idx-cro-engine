import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import type { InfinityScene, SceneFrame } from "./infinity-scene";
import "../../styles/hero.css";

export type HeroBadge = { value: string; label: string };

type Caption = {
  id: string;
  /** entra entre in0 e in1, sai entre out0 e out1 (progresso 0..1) */
  range: [number, number, number, number];
  /** deslocamento de entrada e de saída, em px */
  enter: [number, number];
  exit: [number, number];
};

// Roteiro das legendas: cada uma num canto e num ângulo diferente da câmera.
const CAPTIONS: Caption[] = [
  { id: "welcome", range: [-1, -1, 0.1, 0.17], enter: [0, 0], exit: [0, -70] },
  { id: "card", range: [-1, -1, 0.09, 0.16], enter: [0, 0], exit: [40, 0] },
  { id: "work", range: [0.15, 0.22, 0.33, 0.39], enter: [-90, 0], exit: [0, -50] },
  { id: "motiv", range: [0.38, 0.44, 0.5, 0.55], enter: [90, 0], exit: [0, -50] },
  { id: "endless", range: [0.66, 0.72, 0.82, 0.87], enter: [0, 60], exit: [0, -50] },
  { id: "final", range: [0.88, 0.95, 2, 2], enter: [0, 70], exit: [0, 0] },
];
const BADGES: { range: [number, number, number, number] }[] = [
  { range: [0.0, 0.0, 0.08, 0.14] },
  { range: [0.19, 0.25, 0.33, 0.38] },
];
const STOPS = [0, 0.22, 0.45, 0.7, 1];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  if (b <= a) return v >= a ? 1 : 0;
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function Words({ text, base = 0 }: { text: string; base?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <Fragment key={i}>
          <span className="idx-w"><span style={{ "--i": base + i } as CSSProperties}>{w}</span></span>{" "}
        </Fragment>
      ))}
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function InfinityHero({ tenantName, badges, onEnter }: { tenantName?: string; badges: [HeroBadge, HeroBadge]; onEnter?: () => void }) {
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lightRef = useRef<HTMLDivElement>(null);
  const capRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const badgeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cueRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const [reduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!root || !stage || !canvas) return;
    let scene: InfinityScene | null = null;
    let disposed = false;
    let lastStop = -1;

    // celular: a barra do topo e a barra de abas ficam fixas, o palco desconta as duas
    const measure = () => {
      const narrow = window.matchMedia("(max-width: 720px)").matches;
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
      const top = narrow && sidebar && getComputedStyle(sidebar).position === "sticky" ? sidebar.offsetHeight : 0;
      const bottom = narrow && tabbar && getComputedStyle(tabbar).display !== "none" ? tabbar.offsetHeight : 0;
      root.style.setProperty("--hero-top", `${top}px`);
      root.style.setProperty("--hero-bottom", `${bottom}px`);
      scene?.resize();
    };

    const readProgress = () => {
      if (reduced) return 0;
      const r = root.getBoundingClientRect();
      const total = r.height - stage.offsetHeight;
      return total > 0 ? clamp01((stage.getBoundingClientRect().top - r.top) / total) : 0;
    };

    const apply = (p: number, anchors?: SceneFrame["anchors"]) => {
      if (lightRef.current) lightRef.current.style.opacity = String(smooth(0.53, 0.67, p));
      root.classList.toggle("is-light", p > 0.6);
      for (const c of CAPTIONS) {
        const el = capRefs.current[c.id];
        if (!el) continue;
        const [i0, i1, o0, o1] = c.range;
        const a = i0 < 0 ? 1 : smooth(i0, i1, p);
        const b = 1 - smooth(o0, o1, p);
        const o = a * b;
        const tx = c.enter[0] * (1 - a) + c.exit[0] * (1 - b);
        const ty = c.enter[1] * (1 - a) + c.exit[1] * (1 - b);
        el.style.opacity = o.toFixed(3);
        el.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
        el.style.visibility = o < 0.01 ? "hidden" : "visible";
        el.classList.toggle("on", o > 0.5);
      }
      BADGES.forEach((b, i) => {
        const el = badgeRefs.current[i];
        if (!el) return;
        const [i0, i1, o0, o1] = b.range;
        const anchor = anchors?.[i];
        const o = (i1 <= i0 ? 1 : smooth(i0, i1, p)) * (1 - smooth(o0, o1, p)) * (anchor?.visible === false || !anchor ? 0 : 1);
        el.style.opacity = o.toFixed(3);
        el.style.visibility = o < 0.01 ? "hidden" : "visible";
        if (anchor) el.style.transform = `translate3d(${anchor.x.toFixed(1)}px, ${anchor.y.toFixed(1)}px, 0) scale(${(0.85 + o * 0.15).toFixed(3)})`;
      });
      if (cueRef.current) cueRef.current.style.opacity = String(1 - smooth(0, 0.05, p));
      if (barRef.current) barRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
      let stop = 0;
      STOPS.forEach((s, i) => { if (p >= s - 0.08) stop = i; });
      if (stop !== lastStop && countRef.current) { countRef.current.textContent = String(stop + 1).padStart(2, "0"); lastStop = stop; }
      if (navRef.current) navRef.current.classList.toggle("light", p > 0.6);
      if (fallbackRef.current) fallbackRef.current.style.transform = `translate(-50%, -50%) scale(${(1.6 - p * 0.9).toFixed(3)}) rotate(${(-8 + p * 8).toFixed(2)}deg)`;
    };

    const onScroll = () => {
      const p = readProgress();
      if (scene) scene.setProgress(p);
      else apply(p);
    };
    const onPointer = (e: PointerEvent) => {
      if (!scene || e.pointerType !== "mouse") return;
      scene.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    };

    measure();
    apply(readProgress());

    import("./infinity-scene")
      .then(({ createInfinityScene }) => {
        if (disposed) return;
        try {
          scene = createInfinityScene(canvas, { reducedMotion: reduced, onFrame: (f) => apply(f.progress, f.anchors) });
          scene.setProgress(readProgress());
          setReady(true);
        } catch {
          setFallback(true);
        }
      })
      .catch(() => setFallback(true));

    // só anima enquanto o hero está na tela
    const io = new IntersectionObserver(([entry]) => scene?.setPaused(!entry.isIntersecting), { rootMargin: "80px" });
    io.observe(root);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => {
      disposed = true;
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      window.removeEventListener("pointermove", onPointer);
      scene?.dispose();
      scene = null;
    };
  }, [reduced]);

  const enter = () => {
    const root = rootRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().bottom + window.scrollY - (parseFloat(getComputedStyle(root).getPropertyValue("--hero-top")) || 0) - 8;
    window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    onEnter?.();
  };

  const cap = (id: string, cls: string, children: ReactNode) => (
    <div className={`idx-cap ${cls}`} ref={(el) => { capRefs.current[id] = el; }}>{children}</div>
  );

  return (
    <section className={`idx-hero${reduced ? " is-static" : ""}${ready ? " is-ready" : ""}`} ref={rootRef} aria-label="Boas-vindas ao IDX CRO Engine">
      <div className="idx-hero-stage" ref={stageRef}>
        <div className="idx-hero-bg" aria-hidden="true" />
        <div className="idx-hero-bg light" ref={lightRef} aria-hidden="true" />
        <canvas className="idx-hero-canvas" ref={canvasRef} aria-hidden="true" />
        {fallback && (
          <div className="idx-hero-fallback" ref={fallbackRef} aria-hidden="true">
            <svg viewBox="-260 -100 520 200"><path d="M0 0 C 60 -90 220 -90 220 0 C 220 90 60 90 0 0 C -60 -90 -220 -90 -220 0 C -220 90 -60 90 0 0 Z" /></svg>
          </div>
        )}
        <div className="idx-hero-grain" aria-hidden="true" />

        <div className="idx-hero-nav" ref={navRef}>
          <span className="idx-hero-brand"><b>IDX</b><i /> CRO Engine</span>
          <button type="button" onClick={enter}>Ir para o painel <span><ArrowRight size={14} /></span></button>
        </div>
        <div className="idx-hero-count" aria-hidden="true">
          <span ref={countRef}>01</span><em>/ 05</em>
          <span className="idx-hero-bar"><span ref={barRef} /></span>
        </div>

        {cap("welcome", "pos-bl dark", <>
          <p className="idx-eyebrow"><Words text={`IDX CRO Engine${tenantName ? ` · ${tenantName}` : ""}`} /></p>
          <h2 className="idx-title"><Words text="Bem-vindo ao" /><br /><Words text="IDX CRO Engine!" base={2} /></h2>
          <p className="idx-lead">CRM, WhatsApp e vendas no mesmo lugar. Feito para quem vende todo dia.</p>
        </>)}

        {cap("card", "pos-br", <div className="idx-glass">
          <h3><Words text="Seu painel" /><br /><Words text="está pronto" base={2} /></h3>
          <p>Role para descer ou entre direto. Os números de hoje já estão te esperando.</p>
          <button type="button" onClick={enter}>Abrir meu painel <span><ArrowRight size={14} /></span></button>
        </div>)}

        {cap("work", "pos-tl dark", <>
          <p className="idx-eyebrow"><Words text="Hora de agir" /></p>
          <h2 className="idx-title"><Words text="O trabalho" /><br /><Words text="chama!" base={2} /></h2>
          <p className="idx-lead">Cada contato é uma chance. Cada retorno conta.</p>
        </>)}

        {cap("motiv", "pos-r dark", <>
          <p className="idx-eyebrow"><Words text="Lembrete do dia" /></p>
          <h2 className="idx-title sm"><Words text="Constância hoje." /><br /><Words text="Resultado amanhã." base={2} /></h2>
          <p className="idx-lead">Quem faz o próximo passo todo dia, fecha mais.</p>
        </>)}

        {cap("endless", "pos-b light", <>
          <h2 className="idx-title sm"><Words text="Sem fim." /></h2>
          <p className="idx-lead">Como o crescimento que a gente busca.</p>
          <ul className="idx-specs">
            {["CRM", "WhatsApp", "Discador", "Disparos", "Automações", "Relatórios"].map((s, i) => <li key={s} style={{ "--i": i } as CSSProperties}>{s}</li>)}
          </ul>
        </>)}

        {cap("final", "pos-c light", <>
          <h2 className="idx-title"><Words text={`${greeting()}.`} /><br /><Words text="Vamos ao trabalho." base={2} /></h2>
          <p className="idx-lead">Seu painel está logo abaixo.</p>
          <button type="button" className="idx-cta" onClick={enter}><span>Abrir meu painel</span><span className="sq"><ArrowDown size={15} /></span></button>
        </>)}

        {badges.map((b, i) => (
          <div className="idx-badge" key={i} ref={(el) => { badgeRefs.current[i] = el; }} aria-hidden="true">
            <i className="idx-badge-line" />
            <span className="idx-badge-dot"><strong>{b.value}</strong><small>{b.label}</small></span>
          </div>
        ))}

        <div className="idx-hero-cue" ref={cueRef} aria-hidden="true"><span>Role para descer</span><i /></div>
      </div>
    </section>
  );
}
