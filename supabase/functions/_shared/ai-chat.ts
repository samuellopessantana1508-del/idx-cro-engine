// Resposta em texto livre da IA (mesmo provedor configurado para o resto do CRO).
// AI_PROVIDER = anthropic (padrão) | openai | ollama ; AI_API_KEY ; AI_MODEL ; AI_OLLAMA_URL
export type ChatTurn = { role: "user" | "assistant"; content: string };

export async function chatReply(system: string, turns: ChatTurn[], opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  const apiKey = Deno.env.get("AI_API_KEY") ?? "";
  const provider = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
  const model = Deno.env.get("AI_MODEL") ?? (provider === "openai" ? "gpt-4o-mini" : provider === "ollama" ? "qwen2.5:7b" : "claude-sonnet-4-20250514");
  const maxTokens = opts.maxTokens ?? 500;
  // as APIs exigem alternância começando pelo usuário
  const msgs: ChatTurn[] = [];
  for (const t of turns) {
    const content = t.content.trim();
    if (!content) continue;
    if (msgs.length && msgs[msgs.length - 1].role === t.role) msgs[msgs.length - 1].content += `\n${content}`;
    else msgs.push({ role: t.role, content });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: "(sem mensagem)" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25000);
  try {
    if (provider === "ollama") {
      const url = Deno.env.get("AI_OLLAMA_URL");
      if (!url) throw new Error("IA não configurada");
      const key = apiKey || Deno.env.get("AI_OLLAMA_KEY") || "";
      const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, stream: false, options: { temperature: 0.4 }, messages: [{ role: "system", content: system }, ...msgs] }),
      });
      if (!res.ok) throw new Error(`IA ${res.status}`);
      return String((await res.json()).message?.content ?? "").trim();
    }
    if (!apiKey) throw new Error("IA não configurada (peça ao administrador para configurar a chave de IA)");
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: 0.4, max_tokens: maxTokens, messages: [{ role: "system", content: system }, ...msgs] }),
      });
      if (!res.ok) throw new Error(`IA ${res.status}`);
      return String((await res.json()).choices?.[0]?.message?.content ?? "").trim();
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.4, system, messages: msgs }),
    });
    if (!res.ok) throw new Error(`IA ${res.status}`);
    const data = await res.json();
    return String(data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "").trim();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("IA demorou demais para responder");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
