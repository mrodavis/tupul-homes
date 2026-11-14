// Tupul Homes lead form handler (Vercel serverless function).
// Receives the Free Estimate, Contact and Book Appointment forms from
// tupulhomes.com and emails each lead to Orville through Resend, with a
// Spanish summary he can forward to Antonio.
//
// Env vars (set in Vercel):
//   RESEND_API_KEY   send-only Resend key
//   LEAD_TO          where leads go (orville@scrapit.io)
//   LEAD_FROM        sender on the verified domain, e.g. "Tupul Homes <leads@tupulhomes.com>"

const ALLOWED_ORIGINS = [
  "https://tupulhomes.com",
  "https://www.tupulhomes.com",
];
const FALLBACK_FROM = "Tupul Homes <onboarding@resend.dev>";
const MAX_PHOTOS = 6;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const SERVICES = {
  siding: ["Siding", "Revestimiento exterior (siding)"],
  deck: ["Deck Installation/Repair", "Instalación o reparación de deck"],
  brickwork: ["Brickwork", "Trabajo de ladrillo"],
  pavers: ["Pavers/Walkways/Driveways", "Adoquines, caminos o entradas"],
  lighting: ["Outdoor Lighting", "Iluminación exterior"],
  kitchen: ["Kitchen Renovation", "Remodelación de cocina"],
  bathroom: ["Bathroom Renovation", "Remodelación de baño"],
  wainscoting: ["Wainscoting/Finish Carpentry", "Zócalos y carpintería de acabado"],
  handyman: ["General Handyman", "Reparaciones generales"],
  garage: ["Garage Remodeling", "Remodelación de garaje"],
  basement: ["Basement Remodeling", "Remodelación de sótano"],
  other: ["Other", "Otro"],
};
const TIMES = {
  morning: ["Morning (8 AM - 12 PM)", "Mañana (8 AM - 12 PM)"],
  afternoon: ["Afternoon (12 PM - 4 PM)", "Tarde (12 PM - 4 PM)"],
  evening: ["Evening (4 PM - 7 PM)", "Noche (4 PM - 7 PM)"],
};
const FORM_NAMES = {
  estimate: ["Free Estimate request", "Solicitud de presupuesto gratis"],
  book: ["Appointment request", "Solicitud de cita"],
  contact: ["Contact message", "Mensaje de contacto"],
};

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": allow ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

const clean = (v, max = 2000) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function translateToSpanish(text, request) {
  // Best effort through the Vercel AI Gateway. Falls back to null on any problem.
  if (!text) return null;
  const token =
    process.env.AI_GATEWAY_API_KEY ||
    request?.headers?.get("x-vercel-oidc-token") ||
    process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    console.warn("translate: no gateway token available");
    return null;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.TRANSLATE_MODEL || "anthropic/claude-haiku-4.5",
        temperature: 0,
        messages: [
          { role: "system", content: "Translate the customer's home-improvement request into simple, clear Spanish for a contractor. Return only the translation." },
          { role: "user", content: text },
        ],
      }),
    });
    clearTimeout(t);
    if (!r.ok) {
      console.warn("translate: gateway status", r.status);
      return null;
    }
    const data = await r.json();
    return clean(data?.choices?.[0]?.message?.content, 3000) || null;
  } catch (e) {
    console.warn("translate: failed", e?.name || "error");
    return null;
  }
}

async function sendEmail(payload) {
  const send = (from) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, from }),
    });
  let r = await send(process.env.LEAD_FROM || FALLBACK_FROM);
  if (!r.ok && process.env.LEAD_FROM) {
    // Domain not verified yet: retry from Resend's own sender.
    r = await send(FALLBACK_FROM);
  }
  return r;
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: cors(request.headers.get("origin")) });
}

export async function POST(request) {
  const origin = request.headers.get("origin");
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "Bad request" }, 400, origin);
  }

  // Spam checks: hidden honeypot field, and forms filled in under 3 seconds.
  if (clean(form.get("company"))) return json({ ok: true }, 200, origin);
  const started = Number(form.get("startedAt") || 0);
  if (started && Date.now() - started < 3000) return json({ ok: true }, 200, origin);

  const kind = FORM_NAMES[form.get("form")] ? form.get("form") : "estimate";
  const lead = {
    name: clean(form.get("name"), 120),
    phone: clean(form.get("phone"), 40),
    email: clean(form.get("email"), 160),
    zip: clean(form.get("zip"), 160),
    service: clean(form.get("service"), 40),
    date: clean(form.get("date"), 40),
    time: clean(form.get("time"), 40),
    message: clean(form.get("message"), 4000),
  };
  if (!lead.name || !lead.phone || !lead.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    return json({ ok: false, error: "Please fill in your name, phone and a valid email." }, 422, origin);
  }

  const attachments = [];
  let total = 0;
  for (const f of form.getAll("photos").slice(0, MAX_PHOTOS)) {
    if (!f || typeof f === "string" || !f.size || !/^image\//.test(f.type)) continue;
    total += f.size;
    if (total > MAX_TOTAL_BYTES) break;
    const buf = Buffer.from(await f.arrayBuffer());
    attachments.push({ filename: clean(f.name, 80) || `photo-${attachments.length + 1}.jpg`, content: buf.toString("base64") });
  }

  const svc = SERVICES[lead.service];
  const tm = TIMES[lead.time];
  const [formEn, formEs] = FORM_NAMES[kind];
  const es = await translateToSpanish(lead.message, request);

  const rowsEn = [
    ["Name", lead.name],
    ["Phone", lead.phone],
    ["Email", lead.email],
    ["Address / ZIP", lead.zip],
    ["Service", svc ? svc[0] : lead.service],
    ["Preferred date", lead.date],
    ["Preferred time", tm ? tm[0] : lead.time],
    ["Photos", attachments.length ? `${attachments.length} attached` : ""],
  ].filter(([, v]) => v);
  const rowsEs = [
    ["Cliente", lead.name],
    ["Teléfono", lead.phone],
    ["Dirección / código postal", lead.zip],
    ["Servicio", svc ? svc[1] : lead.service],
    ["Fecha preferida", lead.date],
    ["Horario preferido", tm ? tm[1] : lead.time],
  ].filter(([, v]) => v);
  const msgEs = es || `(En inglés) ${lead.message}`;

  const text = [
    `New ${formEn} from tupulhomes.com`,
    "",
    ...rowsEn.map(([k, v]) => `${k}: ${v}`),
    "",
    "Message:",
    lead.message || "(none)",
    "",
    "------------------------------",
    "PARA ANTONIO (reenviar este resumen)",
    `${formEs} de tupulhomes.com`,
    ...rowsEs.map(([k, v]) => `${k}: ${v}`),
    "Descripción del cliente:",
    msgEs || "(sin descripción)",
  ].join("\n");

  const row = ([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b6b6b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#1a1a1a">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px">
  <div style="background:#2b2b2b;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
    <div style="font-size:12px;letter-spacing:2px;color:#c4915b;text-transform:uppercase">Tupul Homes</div>
    <div style="font-size:20px;font-weight:bold;margin-top:4px">New ${esc(formEn)}</div>
  </div>
  <div style="background:#fff;padding:20px 22px;border-radius:0 0 10px 10px">
    <table style="border-collapse:collapse;font-size:15px">${rowsEn.map(row).join("")}</table>
    <div style="margin-top:14px;font-size:13px;color:#6b6b6b">Message</div>
    <div style="margin-top:4px;font-size:15px;color:#1a1a1a;white-space:pre-wrap">${esc(lead.message || "(none)")}</div>
    <div style="margin-top:22px;padding:16px;border:2px dashed #c4915b;border-radius:8px;background:#fbf7f1">
      <div style="font-size:12px;letter-spacing:1px;color:#a67848;font-weight:bold">PARA ANTONIO · reenviar este resumen</div>
      <div style="font-size:16px;font-weight:bold;margin:6px 0 8px">${esc(formEs)}</div>
      <table style="border-collapse:collapse;font-size:15px">${rowsEs.map(row).join("")}</table>
      <div style="margin-top:10px;font-size:13px;color:#6b6b6b">Descripción del cliente</div>
      <div style="margin-top:4px;font-size:15px;white-space:pre-wrap">${esc(msgEs || "(sin descripción)")}</div>
    </div>
    <div style="margin-top:16px;font-size:12px;color:#8a8a8a">Reply to this email to answer the customer directly.</div>
  </div>
</div></body></html>`;

  const subjectBits = [svc ? svc[0] : formEn, lead.name, lead.zip].filter(Boolean).join(" · ");
  const r = await sendEmail({
    to: [process.env.LEAD_TO || "orville@scrapit.io"],
    reply_to: lead.email,
    subject: `New Tupul Homes lead: ${subjectBits}`,
    text,
    html,
    attachments: attachments.length ? attachments : undefined,
  });
  if (!r.ok) {
    console.error("Resend error", r.status, await r.text());
    return json({ ok: false, error: "We couldn't send your request. Please call us." }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}
