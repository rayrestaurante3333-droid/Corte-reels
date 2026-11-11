// CortaViral — analisa um vídeo com a IA do Google (Gemini) e grava os melhores cortes.
// Ações (POST JSON):
//   { "acao": "info", "url": "<link do YouTube>" }   -> { canal, titulo }
//   { "acao": "analisar", "video_id": "<uuid>" }    -> inicia a análise em segundo plano
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELOS = (Deno.env.get("GEMINI_MODEL") ??
  "gemini-3.7-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-2.5-flash").split(",").map((s) => s.trim()).filter(Boolean);
const API = "https://generativelanguage.googleapis.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function idYoutube(u: string | null): string | null {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(u ?? "");
  return m ? m[1] : null;
}

async function infoYoutube(url: string) {
  const id = idYoutube(url);
  if (!id) return null;
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return { canal: String(j.author_name ?? "").slice(0, 200), titulo: String(j.title ?? "").slice(0, 200) };
}

const PROMPT = `Você é um editor especialista em vídeos virais para Reels, TikTok e YouTube Shorts no Brasil.
Assista ao vídeo inteiro (áudio e imagem) e escolha de 3 a 6 trechos com maior potencial de viralizar.
Regras para cada trecho:
- Entre 20 e 60 segundos. Precisa fazer sentido sozinho, sem o resto do vídeo.
- Comece em um gancho forte (frase de impacto, pergunta, revelação, emoção, humor ou polêmica) e termine em uma frase completa.
- Os trechos não podem se sobrepor.
- "inicio" e "fim" em SEGUNDOS a partir do começo do vídeo, exatos.
- "nota_viral" de 0 a 100: força do gancho, emoção, clareza e potencial de compartilhamento.
- "titulo": até 50 caracteres, chamativo, em português do Brasil.
- "legenda": legenda pronta para postar, até 150 caracteres, com 1 ou 2 emojis.
- "hashtags": 3 a 5 hashtags relevantes, começando com #.
- "motivo": uma frase curta explicando por que esse trecho funciona.
Ordene do mais viral para o menos viral. Responda só com o JSON pedido.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    clipes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          inicio: { type: "NUMBER" },
          fim: { type: "NUMBER" },
          nota_viral: { type: "INTEGER" },
          titulo: { type: "STRING" },
          legenda: { type: "STRING" },
          hashtags: { type: "ARRAY", items: { type: "STRING" } },
          motivo: { type: "STRING" },
        },
        required: ["inicio", "fim", "nota_viral", "titulo", "legenda", "hashtags", "motivo"],
      },
    },
  },
  required: ["clipes"],
};

async function chamarGemini(videoPart: Record<string, unknown>) {
  let ultimoErro = "";
  for (const modelo of MODELOS) {
    const r = await fetch(`${API}/v1beta/models/${modelo}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [videoPart, { text: PROMPT }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.4 },
      }),
    });
    const txt = await r.text();
    if (r.ok) {
      const j = JSON.parse(txt);
      const out = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
      return JSON.parse(out);
    }
    ultimoErro = `${modelo}: HTTP ${r.status} ${txt.slice(0, 300)}`;
    console.error("gemini", ultimoErro);
    // modelo inexistente, sem acesso ou sem cota -> tenta o próximo
    if (![400, 403, 404, 429].includes(r.status)) break;
    if (r.status === 400 && !/model|not found|not supported/i.test(txt)) break;
  }
  throw new Error(ultimoErro || "Falha na IA");
}

async function enviarArquivoGemini(bytes: Uint8Array, mime: string, nome: string) {
  const ini = await fetch(`${API}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: nome.slice(0, 100) } }),
  });
  const url = ini.headers.get("x-goog-upload-url");
  if (!url) throw new Error("Não foi possível iniciar o envio para a IA: " + (await ini.text()).slice(0, 200));
  const up = await fetch(url, {
    method: "POST",
    headers: { "Content-Length": String(bytes.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: bytes,
  });
  const f = (await up.json())?.file;
  if (!f?.name) throw new Error("Envio do arquivo para a IA falhou");
  for (let i = 0; i < 40 && f.state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await (await fetch(`${API}/v1beta/${f.name}`, { headers: { "x-goog-api-key": GEMINI_KEY } })).json();
    f.state = s.state;
    if (s.state === "FAILED") throw new Error("A IA não conseguiu ler o arquivo de vídeo");
  }
  if (f.state !== "ACTIVE") throw new Error("A IA demorou demais para processar o arquivo");
  return { uri: f.uri as string, nome: f.name as string, mime };
}

function limpaClipes(lista: unknown[]) {
  const ok: Record<string, unknown>[] = [];
  for (const c of (Array.isArray(lista) ? lista : []) as Record<string, unknown>[]) {
    const ini = Math.max(0, Number(c.inicio));
    const fim = Number(c.fim);
    if (!isFinite(ini) || !isFinite(fim) || fim - ini < 5 || fim - ini > 180) continue;
    if (ok.some((o) => ini < (o.fim_segundos as number) && fim > (o.inicio_segundos as number))) continue;
    ok.push({
      inicio_segundos: Math.round(ini),
      fim_segundos: Math.round(fim),
      nota_viral: Math.min(100, Math.max(0, Math.round(Number(c.nota_viral) || 0))),
      titulo: String(c.titulo ?? "Clipe").slice(0, 80),
      legenda: String(c.legenda ?? "").slice(0, 300),
      hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => String(h).slice(0, 40)).slice(0, 8),
      motivo: String(c.motivo ?? "").slice(0, 300),
    });
    if (ok.length >= 6) break;
  }
  return ok;
}

async function analisar(admin: ReturnType<typeof createClient>, v: Record<string, string | null>) {
  let arquivoGemini: string | null = null;
  try {
    let part: Record<string, unknown>;
    const yt = idYoutube(v.link_origem);
    if (yt) {
      part = { file_data: { file_uri: `https://www.youtube.com/watch?v=${yt}` } };
    } else if (v.caminho_arquivo) {
      const d = await admin.storage.from("videos").download(v.caminho_arquivo);
      if (d.error || !d.data) throw new Error("Não foi possível abrir o arquivo enviado");
      const bytes = new Uint8Array(await d.data.arrayBuffer());
      const mime = d.data.type || "video/mp4";
      const f = await enviarArquivoGemini(bytes, mime, v.titulo ?? "video");
      arquivoGemini = f.nome;
      part = { file_data: { file_uri: f.uri, mime_type: f.mime } };
    } else {
      throw new Error("Por enquanto a análise automática funciona com links do YouTube ou arquivos enviados");
    }

    const res = await chamarGemini(part);
    const clipes = limpaClipes(res?.clipes);
    if (!clipes.length) throw new Error("A IA não encontrou trechos bons neste vídeo");

    await admin.from("clipes").delete().eq("video_id", v.id);
    const ins = await admin.from("clipes").insert(clipes.map((c) => ({ ...c, video_id: v.id, usuario_id: v.usuario_id })));
    if (ins.error) throw new Error("Erro ao salvar os cortes: " + ins.error.message);
    await admin.from("videos").update({ status: "pronto", erro_detalhe: null, analisado_em: new Date().toISOString() }).eq("id", v.id);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("analise falhou", v.id, m);
    const amigavel = /429|quota|RESOURCE_EXHAUSTED/i.test(m)
      ? "Muitos vídeos sendo analisados agora. Tente de novo em alguns minutos."
      : /private|unavailable|not accessible|PERMISSION/i.test(m)
      ? "Não conseguimos acessar esse vídeo. Ele precisa ser público no YouTube."
      : /^Erro|^Não|^A IA|^Por enquanto|^Envio/.test(m) ? m : "Não conseguimos analisar este vídeo. Tente de novo.";
    await admin.from("videos").update({ status: "erro", erro_detalhe: amigavel }).eq("id", v.id);
  } finally {
    if (arquivoGemini) fetch(`${API}/v1beta/${arquivoGemini}`, { method: "DELETE", headers: { "x-goog-api-key": GEMINI_KEY } }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ erro: "Faça login de novo." }, 401);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ erro: "Pedido inválido" }, 400); }

  if (body.acao === "info") {
    const info = await infoYoutube(String(body.url ?? "").slice(0, 500)).catch(() => null);
    return json(info ?? { canal: null, titulo: null });
  }

  if (body.acao === "analisar") {
    if (!GEMINI_KEY) return json({ erro: "A análise automática ainda não foi configurada." }, 503);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    // trava: só pega vídeo do próprio usuário, que esteja na fila ou com erro, e marca como "analisando"
    const { data: v, error } = await admin.from("videos")
      .update({ status: "analisando", erro_detalhe: null })
      .eq("id", String(body.video_id ?? ""))
      .eq("usuario_id", u.user.id)
      .is("excluido_em", null)
      .in("status", ["enviado", "erro"])
      .select("id, usuario_id, link_origem, caminho_arquivo, titulo")
      .maybeSingle();
    if (error) return json({ erro: "Não foi possível iniciar a análise." }, 500);
    if (!v) return json({ erro: "Este vídeo já está sendo analisado ou já está pronto." }, 409);

    if (!v.caminho_arquivo && v.link_origem) {
      const info = await infoYoutube(v.link_origem).catch(() => null);
      if (info?.canal) await admin.from("videos").update({ canal_origem: info.canal, titulo: info.titulo || v.titulo }).eq("id", v.id);
    }
    EdgeRuntime.waitUntil(analisar(admin, v as Record<string, string | null>));
    return json({ ok: true, status: "analisando" });
  }

  return json({ erro: "Ação desconhecida" }, 400);
});
