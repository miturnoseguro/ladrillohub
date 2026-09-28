// Deploy: supabase functions deploy solicitar-asociacion-google
// Secrets: RESEND_API_KEY, MAIL_FROM  (supabase secrets set ...)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
Deno.serve(async (req) => {
  const { solicitud_id } = await req.json();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: s } = await sb.from("solicitudes_asociacion_google")
    .select("maps_url, desarrolladoras(nombre, email_provisorio, perfiles:perfil_id(email))").eq("id", solicitud_id).single();
  // Google no expone el mail del dueño de una ficha de Maps: usamos el email cargado de la empresa.
  const to = s?.desarrolladoras?.email_provisorio || s?.desarrolladoras?.perfiles?.email;
  if (!to) return new Response("sin email destino", { status: 422 });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("MAIL_FROM"), to,
      subject: "Ladrillo Hub: confirmá la asociación con tu perfil de Google Maps",
      html: `<p>Pidieron asociar <b>${s.desarrolladoras.nombre}</b> con este establecimiento de Google Maps:</p><p><a href="${s.maps_url}">${s.maps_url}</a></p><p>Si es tu empresa, respondé este email para confirmar.</p>` }),
  });
  return new Response(await r.text(), { status: r.status });
});
