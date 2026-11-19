import { useEffect, useRef, useState, type RefObject } from "react";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Revela com cascata os elementos marcados dentro do contêiner quando entram na tela.
 * Observa novos nós (dados que chegam depois do esqueleto de carregamento).
 */
export function useReveal(ref: RefObject<HTMLElement>, selector: string, ready = true) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (reducedMotion() || !("IntersectionObserver" in window)) return;
    const seen = new WeakSet<Element>();
    let batch = 0;
    let batchTimer = 0;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.style.setProperty("--rv-d", `${Math.min(batch, 8) * 70}ms`);
        batch++;
        el.classList.add("rv-in");
        // depois da entrada, zera o atraso para o hover responder na hora
        window.setTimeout(() => el.style.setProperty("--rv-d", "0ms"), 1400);
        io.unobserve(el);
      }
      window.clearTimeout(batchTimer);
      batchTimer = window.setTimeout(() => { batch = 0; }, 160);
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });

    const scan = () => {
      root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        el.classList.add("rv");
        io.observe(el);
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
      window.clearTimeout(batchTimer);
    };
  }, [ref, selector, ready]);
}

const NUM = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/;

/** Conta de 0 até o número do texto (ex.: "R$ 12,3 mil"), mantendo o formato pt-BR. */
export function CountUp({ value, duration = 1100 }: { value: string | number; duration?: number }) {
  const text = String(value);
  const match = text.match(NUM);
  const [shown, setShown] = useState(text);
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!match || reducedMotion()) { setShown(text); return; }
    const raw = match[0];
    const decimals = raw.includes(",") ? raw.split(",")[1].length : 0;
    const grouped = raw.includes(".");
    const target = Number(raw.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(target) || target === 0) { setShown(text); return; }
    const fmt = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
    const before = text.slice(0, match.index);
    const after = text.slice((match.index ?? 0) + raw.length);
    let raf = 0;
    let start = 0;
    const run = () => {
      const step = (now: number) => {
        if (!start) start = now;
        const t = Math.min(1, (now - start) / duration);
        const e = 1 - Math.pow(2, -10 * t); // easeOutExpo
        setShown(t >= 1 ? text : `${before}${fmt(target * e)}${after}`);
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    // só começa quando o número aparece na tela
    const el = spanRef.current;
    if (!el || !("IntersectionObserver" in window)) { run(); return () => cancelAnimationFrame(raf); }
    setShown(`${before}${fmt(0)}${after}`);
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { io.disconnect(); run(); } }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, duration]);

  return <span ref={spanRef} className="crm-countup">{shown}</span>;
}
