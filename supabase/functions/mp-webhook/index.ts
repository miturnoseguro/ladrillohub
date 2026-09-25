
// supabase/functions/mp-webhook/index.ts
//
// Webhook PÚBLICO de Mercado Pago. Mercado Pago llama a esta URL cada vez
// que hay una novedad de pago. NO lleva verificación de JWT de Supabase
// (Mercado Pago no manda un JWT nuestro), así que hay que desplegarla con
// --no-verify-jwt.
//
// Deploy:
//   supabase functions deploy mp-webhook --no-verify-jwt
//
// Secrets necesarios (ya deberían existir si desplegaste create-preference):
//   supabase secrets set MP_ACCESS_TOKEN=tu_access_token
//
// Configuración en Mercado Pago:
//   Developers > Tu app (LadrilloHub) > Webhooks > Configurar notificaciones
//   URL:  https://TU_PROYECTO.supabase.co/functions/v1/mp-webhook
//   Eventos: tildá "Pagos"
//
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya existen automáticamente en el
// entorno de toda Edge Function de Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ ok: true });

    const body = await req.json().catch(() => ({}));

    // Mercado Pago manda varios formatos de evento (payment, merchant_order,
    // etc.). Solo nos interesan los de tipo "payment".
    const paymentId = body?.data?.id ?? body?.id;
    const type = body?.type ?? body?.topic;

    if (type !== "payment" || !paymentId) {
      return json({ ok: true });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Consultar el pago REAL contra la API de Mercado Pago.
    //    Nunca confiar en el contenido del webhook en sí: solo nos dice
    //    "pasó algo con este id", hay que ir a buscarlo.
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error("No se pudo consultar el pago en MP:", await mpRes.text());
      // Devolvemos 200 igual para que Mercado Pago no reintente en loop
      return json({ ok: true });
    }

    const payment = await mpRes.json();
    const externalReference = payment.external_reference; // == pagos.id
    const status = payment.status; // approved | pending | rejected | ...

    if (!externalReference) return json({ ok: true });

    // 2) Buscar la fila de "pagos" que corresponde a este pago
    const { data: pago, error: pagoErr } = await admin
      .from("pagos")
      .select("id, lead_id, rol, estado")
      .eq("id", externalReference)
      .maybeSingle();

    if (pagoErr || !pago) {
      console.error("Pago no encontrado para external_reference:", externalReference);
      return json({ ok: true });
    }

    // Guardamos el webhook crudo y el payment id siempre, para trazabilidad
    await admin
      .from("pagos")
      .update({ mp_payment_id: String(paymentId), raw_webhook: payment })
      .eq("id", pago.id);

    // Idempotencia: Mercado Pago puede reenviar el mismo aviso varias veces.
    // Si ya lo habíamos marcado aprobado, no repetir los efectos (no mandar
    // el mail dos veces, etc.)
    if (pago.estado === "aprobado") return json({ ok: true });

    if (status === "approved") {
      await admin.from("pagos").update({ estado: "aprobado" }).eq("id", pago.id);

      if (pago.rol === "comprador") {
        await admin
          .from("leads")
          .update({ comprador_pago: true, comprador_pago_at: new Date().toISOString() })
          .eq("id", pago.lead_id);

        // Avisarle a la desarrolladora que tiene un lead pago esperando
        await fetch(`${SUPABASE_URL}/functions/v1/notify-developer-lead`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ lead_id: pago.lead_id }),
        }).catch((e) => console.error("Error notificando a la desarrolladora:", e));
      } else if (pago.rol === "desarrolladora") {
        await admin
          .from("leads")
          .update({ desarrolladora_pago: true, desarrolladora_pago_at: new Date().toISOString() })
          .eq("id", pago.lead_id);

        // Si ambos ya pagaron, revelamos el contacto
        const { data: leadActualizado } = await admin
          .from("leads")
          .select("comprador_pago, desarrolladora_pago")
          .eq("id", pago.lead_id)
          .maybeSingle();

        if (leadActualizado?.comprador_pago && leadActualizado?.desarrolladora_pago) {
          await admin.from("leads").update({ contacto_revelado: true }).eq("id", pago.lead_id);
        }
      }
    } else if (status === "rejected") {
      await admin.from("pagos").update({ estado: "rechazado" }).eq("id", pago.id);
    }

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    // Devolvemos 200 igual: si devolvemos error, Mercado Pago reintenta de forma agresiva
    return json({ ok: true });
  }
});
