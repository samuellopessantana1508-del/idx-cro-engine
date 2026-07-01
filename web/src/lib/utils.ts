export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 64);
}

export function linkCode(seed: string): string {
  const base = slugify(seed).replace(/-/g, "").slice(0, 8) || "link";
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

export function formatMoney(value: number | null | undefined): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value ?? 0));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function timeAgo(value: string): string {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function envConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function redirectBase(): string {
  return String(import.meta.env.VITE_PUBLIC_REDIRECT_BASE || import.meta.env.VITE_SUPABASE_URL || "https://go.idx.app").replace(/\/$/, "");
}

export function redirectPrefix(): string {
  return String(import.meta.env.VITE_REDIRECT_PATH_PREFIX || "/functions/v1/go").replace(/\/$/, "");
}

export function smartLinkUrl(code: string): string {
  return `${redirectBase()}${redirectPrefix()}/${code}`;
}

