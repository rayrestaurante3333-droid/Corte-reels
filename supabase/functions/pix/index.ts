// CortaViral — pagamento por Pix (Mercado Pago) dos Reels prontos de um vídeo.
// Com login (POST JSON):
//   { "acao": "criar",  "video_id": "<uuid>", "quantidade": 1|3|5 } -> { pago } ou { pagamento_id, copia_cola, qr_base64, valor, expira_em }
//   { "acao": "status", "pagamento_id": "<uuid>" }   -> { status: "pendente" | "pago" | "cancelado" }
// Sem login: POST ?webhook=1  (aviso do Mercado Pago; o pagamento é sempre conferido na API do Mercado Pago)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MP_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const PRECO = Number(Deno.env.get("PRECO_REEL") ?? "8.99");
const MP = "https://api.mercadopago.com";
const WEBHOOK = `${SUPABASE_URL}/functions/v1/pix?webhook=1`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

async function buscarPagamentoMP(id: string) {
  const r = await fetch(`${MP}/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
  if (!r.ok) throw new Error(`MP HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Confere no Mercado Pago e, se aprovado, libera o Reel. Nunca confia só no aviso recebido.
async function sincronizar(mpId: string) {
  const p = await buscarPagamentoMP(mpId);
  const ref = String(p.external_reference ?? "");
  const { data: pag } = await admin.from("pagamentos").select("id, video_id, quantidade, valor, status, mp_payment_id").eq("id", ref).maybeSingle();
  if (!pag || pag.mp_payment_id !== String(p.id)) return "desconhecido";
  if (p.status === "approved" && Number(p.transaction_amount) >= Number(pag.valor) && p.currency_id === "BRL") {
    if (pag.status !== "pago") {
      await admin.from("pagamentos").update({ status: "pago", pago_em: new Date().toISOString() }).eq("id", pag.id);
      await admin.from("videos").update({ klap_status: "pago", reels_qtd: pag.quantidade }).eq("id", pag.video_id).is("klap_status", null);
    }
    return "pago";
  }
  if (["cancelled", "rejected", "expired", "refunded", "charged_back"].includes(p.status)) {
    if (pag.status === "pendente") await admin.from("pagamentos").update({ status: "cancelado" }).eq("id", pag.id);
    if (pag.status === "pago" && ["refunded", "charged_back"].includes(p.status)) {
      await admin.from("pagamentos").update({ status: "cancelado" }).eq("id", pag.id);
      await admin.from("clipes").update({ pago: false }).eq("video_id", pag.video_id).eq("origem", "reel");
    }
    return "cancelado";
  }
  return "pendente";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);
  const url = new URL(req.url);

  // Aviso do Mercado Pago
  if (url.searchParams.get("webhook") === "1") {
    let id = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "";
    try {
      const b = await req.json();
      if (!id) id = String(b?.data?.id ?? "");
      if (b?.type && b.type !== "payment" && !String(b?.action ?? "").startsWith("payment")) return json({ ok: true });
    } catch { /* sem corpo */ }
    if (!/^\d{1,30}$/.test(id) || !MP_TOKEN) return json({ ok: true });
    try { await sincronizar(id); } catch (e) { console.error("webhook", e); }
    return json({ ok: true });
  }

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ erro: "Faça login de novo." }, 401);
  if (!MP_TOKEN) return json({ erro: "O pagamento por Pix ainda não foi configurado." }, 503);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ erro: "Pedido inválido" }, 400); }

  if (body.acao === "criar") {
    const qtd = [1, 3, 5].includes(Number(body.quantidade)) ? Number(body.quantidade) : 1;
    const { data: v } = await admin.from("videos").select("id, titulo, link_origem, klap_status")
      .eq("id", String(body.video_id ?? "")).eq("usuario_id", u.user.id).is("excluido_em", null).maybeSingle();
    if (!v || !v.link_origem) return json({ erro: "Vídeo não encontrado." }, 404);
    if (v.klap_status) return json({ pago: true });
    const valor = Math.round(PRECO * qtd * 100) / 100;

    // reaproveita um Pix pendente ainda válido com a mesma quantidade (evita cobranças duplicadas)
    const { data: aberto } = await admin.from("pagamentos").select("id, pix_copia_cola, pix_qr_base64, valor, expira_em")
      .eq("video_id", v.id).eq("quantidade", qtd).eq("status", "pendente").gt("expira_em", new Date(Date.now() + 60_000).toISOString())
      .order("criado_em", { ascending: false }).limit(1).maybeSingle();
    if (aberto?.pix_copia_cola) {
      return json({ pagamento_id: aberto.id, copia_cola: aberto.pix_copia_cola, qr_base64: aberto.pix_qr_base64, valor: aberto.valor, expira_em: aberto.expira_em });
    }

    const expira = new Date(Date.now() + 30 * 60_000);
    const { data: pag, error } = await admin.from("pagamentos")
      .insert({ usuario_id: u.user.id, video_id: v.id, quantidade: qtd, valor, expira_em: expira.toISOString() }).select("id").single();
    if (error || !pag) return json({ erro: "Não foi possível criar o pagamento." }, 500);

    const r = await fetch(`${MP}/v1/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MP_TOKEN}`, "Content-Type": "application/json", "X-Idempotency-Key": pag.id },
      body: JSON.stringify({
        transaction_amount: valor,
        description: `CortaViral - ${qtd} Reel(s) pronto(s): ${String(v.titulo ?? "video").slice(0, 50)}`,
        payment_method_id: "pix",
        payer: { email: u.user.email },
        external_reference: pag.id,
        notification_url: WEBHOOK,
        date_of_expiration: expira.toISOString().replace("Z", "+00:00"),
      }),
    });
    const t = await r.text();
    if (!r.ok) {
      console.error("mp criar", r.status, t.slice(0, 400));
      await admin.from("pagamentos").update({ status: "cancelado" }).eq("id", pag.id);
      return json({ erro: "Não foi possível gerar o Pix agora. Tente de novo." }, 502);
    }
    const p = JSON.parse(t);
    const td = p?.point_of_interaction?.transaction_data ?? {};
    await admin.from("pagamentos").update({
      mp_payment_id: String(p.id), pix_copia_cola: td.qr_code ?? null, pix_qr_base64: td.qr_code_base64 ?? null,
    }).eq("id", pag.id);
    return json({ pagamento_id: pag.id, copia_cola: td.qr_code, qr_base64: td.qr_code_base64, valor, expira_em: expira.toISOString() });
  }

  if (body.acao === "status") {
    const { data: pag } = await admin.from("pagamentos").select("id, status, mp_payment_id")
      .eq("id", String(body.pagamento_id ?? "")).eq("usuario_id", u.user.id).maybeSingle();
    if (!pag) return json({ erro: "Pagamento não encontrado." }, 404);
    if (pag.status !== "pendente" || !pag.mp_payment_id) return json({ status: pag.status });
    try { return json({ status: await sincronizar(pag.mp_payment_id) }); }
    catch (e) { console.error("status", e); return json({ status: "pendente" }); }
  }

  return json({ erro: "Ação desconhecida" }, 400);
});
