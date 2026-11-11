// CorteHype — números do negócio, só para contas com plano "admin".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ erro: "Faça login de novo." }, 401);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: eu } = await admin.from("perfis").select("plano").eq("id", u.user.id).maybeSingle();
  if (eu?.plano !== "admin") return json({ erro: "Acesso negado." }, 403);

  const seteDias = new Date(Date.now() - 7 * 864e5).toISOString();
  // meia-noite de hoje no horário de Brasília (UTC-3)
  const hoje = new Date(Date.now() - 3 * 3600e3); hoje.setUTCHours(0, 0, 0, 0); hoje.setTime(hoje.getTime() + 3 * 3600e3);
  const cnt = async (t: string, f?: (q: any) => any) => {
    let q = admin.from(t).select("id", { count: "exact", head: true });
    if (f) q = f(q);
    const { count } = await q;
    return count ?? 0;
  };
  const [usuarios, novos7, videos, videos7, reelsBaixados] = await Promise.all([
    cnt("perfis"),
    cnt("perfis", (q) => q.gte("criado_em", seteDias)),
    cnt("videos"),
    cnt("videos", (q) => q.gte("criado_em", seteDias)),
    cnt("clipes", (q) => q.not("video_url", "is", null)),
  ]);
  const { data: pagos } = await admin.from("pagamentos").select("valor, quantidade, pago_em").eq("status", "pago");
  const somar = (l: any[]) => l.reduce((a, p) => a + Number(p.valor || 0), 0);
  const p = pagos ?? [];
  const { data: ultimos } = await admin.from("perfis").select("nome, email, plano, criado_em").order("criado_em", { ascending: false }).limit(15);
  const { data: ultPag } = await admin.from("pagamentos").select("valor, quantidade, status, criado_em, usuario_id")
    .order("criado_em", { ascending: false }).limit(15);
  const ids = [...new Set((ultPag ?? []).map((x: any) => x.usuario_id))];
  const { data: donos } = ids.length ? await admin.from("perfis").select("id, email").in("id", ids) : { data: [] as any[] };
  const emailDe = new Map((donos ?? []).map((d: any) => [d.id, d.email]));

  return json({
    usuarios, novos7, videos, videos7, reelsBaixados,
    vendas: p.length,
    faturamento: somar(p),
    faturamentoHoje: somar(p.filter((x) => x.pago_em && new Date(x.pago_em) >= hoje)),
    reelsVendidos: p.reduce((a, x) => a + Number(x.quantidade || 0), 0),
    ultimosCadastros: ultimos ?? [],
    ultimosPagamentos: (ultPag ?? []).map((x: any) => ({ valor: x.valor, quantidade: x.quantidade, status: x.status, criado_em: x.criado_em, email: emailDe.get(x.usuario_id) ?? "" })),
  });
});
