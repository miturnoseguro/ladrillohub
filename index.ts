// supabase/functions/mp-webhook/index.ts
//
// Mercado Pago llama a esta URL cada vez que cambia el estado de un pago.
// Acá lo confirmamos, actualizamos la fila en "pagos" y, si están los dos
// pagos del lead (comprador + desarrolladora), marcamos el match y
// revelamos el contacto.
//
// Deploy:
//   supabase functions deploy mp-webhook --no-verify-jwt
//   (--no-verify-jwt porque Mercado Pago no manda un JWT de Supabase)
//
// Configurá esta URL como "notification_url" en Mercado Pago:
//   https://TU_PROYECTO.functions.supabase.co/mp-webhook

import { createClient } from "npm:@supabase/supabase-js@2";

const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const topic = url.searchParams.get("topic") ?? url.searchParams.get("type");
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const paymentId = body?.data?.id ?? url.searchParams.get("id");

    if (topic !== "payment" || !paymentId) {
      // Mercado Pago también manda notificaciones de "merchant_order"; las ignoramos.
      return new Response("ignored", { status: 200 });
    }

    // Consultamos el pago real contra la API de Mercado Pago (nunca confiar en el payload solo)
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    if (!mpRes.ok) return new Response("no se pudo verificar el pago", { status: 200 });
    const mpPayment = await mpRes.json();

    const pagoId = mpPayment.external_reference; // el id de nuestra fila "pagos"
    const status = mpPayment.status; // approved | pending | rejected | cancelled

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const estado = status === "approved" ? "aprobado" : status === "rejected" ? "rechazado" : status === "cancelled" ? "cancelado" : "pendiente";

    const { data: pago, error: pagoErr } = await supabase
      .from("pagos")
      .update({ mp_payment_id: String(mpPayment.id), estado, raw_webhook: mpPayment })
      .eq("id", pagoId)
      .select()
      .single();
    if (pagoErr || !pago) return new Response("pago no encontrado", { status: 200 });

    if (estado === "aprobado") {
      // Marcamos el lado correspondiente del lead
      const campo = pago.rol === "comprador" ? { comprador_pago: true, comprador_pago_at: new Date().toISOString() }
                                              : { desarrolladora_pago: true, desarrolladora_pago_at: new Date().toISOString() };
      const { data: lead } = await supabase.from("leads").update(campo).eq("id", pago.lead_id).select().single();

      // Si ambas partes ya pagaron, confirmamos el match y revelamos contacto
      if (lead?.comprador_pago && lead?.desarrolladora_pago) {
        await supabase.from("leads").update({ estado: "match", contacto_revelado: true }).eq("id", lead.id);
      } else if (lead?.comprador_pago || lead?.desarrolladora_pago) {
        await supabase
          .from("leads")
          .update({ estado: pago.rol === "comprador" ? "comprador_pago" : "desarrolladora_pago" })
          .eq("id", lead.id);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 200 }); // 200 para que MP no reintente en loop
  }
});
