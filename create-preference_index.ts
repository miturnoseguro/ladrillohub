// supabase/functions/create-preference/index.ts
//
// La llama el navegador (app.html) cuando el comprador o la desarrolladora
// aprietan "Pagar". Verifica quién es el usuario logueado, crea la fila en
// "pagos" (con la service role, porque la tabla no tiene policy de insert
// para el cliente) y arma la preferencia de pago en Mercado Pago.
//
// Deploy (SÍ lleva verificación de JWT, a diferencia de mp-webhook):
//   supabase functions deploy create-preference
//
// Secrets necesarios (una sola vez):
//   supabase secrets set MP_ACCESS_TOKEN=tu_access_token
//   supabase secrets set SITE_URL=https://tu-usuario.github.io/tu-repo/app.html
//
// SUPABASE_URL y SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ya existen
// automáticamente en el entorno de toda Edge Function de Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "";

// CORS: la llamada viene desde el navegador en GitHub Pages, un dominio
// distinto al de la Edge Function, así que hace falta permitirlo a mano.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "método no permitido" }, 405);

    // 1) Identificar al usuario logueado a partir del JWT que manda sb.functions.invoke
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) return json({ error: "no autenticado" }, 401);

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "token inválido" }, 401);
    const user = userData.user;

    // 2) Validar body
    const body = await req.json().catch(() => ({}));
    const leadId = body?.lead_id;
    const rol = body?.rol;
    if (!leadId || (rol !== "comprador" && rol !== "desarrolladora")) {
      return json({ error: "faltan lead_id o rol" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 3) Traer el lead + proyecto + desarrolladora para validar quién puede pagar qué
    const { data: lead, error: leadErr } = await admin
      .from("leads")
      .select("id, proyecto_id, comprador_id, proyectos(nombre, desarrolladora_id, desarrolladoras(perfil_id))")
      .eq("id", leadId)
      .single();
    if (leadErr || !lead) return json({ error: "lead no encontrado" }, 404);

    if (rol === "comprador") {
      if (lead.comprador_id !== user.id) return json({ error: "no autorizado" }, 403);
    } else {
      const perfilAdmin = (lead as any).proyectos?.desarrolladoras?.perfil_id;
      if (perfilAdmin !== user.id) return json({ error: "no autorizado" }, 403);
    }

    const monto = rol === "comprador" ? 10000 : 50000;
    const nombreProyecto = (lead as any).proyectos?.nombre ?? "Ladrillo Hub";

    // 4) Crear la fila de pago (pendiente) — solo la Edge Function puede insertar acá
    const { data: pago, error: pagoErr } = await admin
      .from("pagos")
      .insert({ lead_id: leadId, perfil_id: user.id, rol, monto, moneda: "ARS", estado: "pendiente" })
      .select()
      .single();
    if (pagoErr || !pago) {
      console.error(pagoErr);
      return json({ error: "no se pudo crear el registro de pago" }, 500);
    }

    // 5) Armar la preferencia en Mercado Pago
    const preference = {
      items: [
        {
          title:
            rol === "comprador"
              ? `Ladrillo Hub · Enviar ficha (${nombreProyecto})`
              : `Ladrillo Hub · Recibir ficha (${nombreProyecto})`,
          quantity: 1,
          currency_id: "ARS",
          unit_price: monto,
        },
      ],
      external_reference: pago.id,
      notification_url: `${SUPABASE_URL}/functions/v1/mp-webhook`,
      back_urls: {
        success: `${SITE_URL}?pago=ok`,
        failure: `${SITE_URL}?pago=error`,
        pending: `${SITE_URL}?pago=pendiente`,
      },
      auto_return: "approved",
    };

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(preference),
    });
    const mpData = await mpRes.json();

    if (!mpRes.ok) {
      console.error("MP error:", mpData);
      return json({ error: "Mercado Pago rechazó la preferencia" }, 502);
    }

    await admin.from("pagos").update({ mp_preference_id: mpData.id }).eq("id", pago.id);

    // 6) Devolver el link de pago al navegador, que hace window.location.href = init_point
    return json({ init_point: mpData.init_point, sandbox_init_point: mpData.sandbox_init_point });
  } catch (e) {
    console.error(e);
    return json({ error: "error interno" }, 500);
  }
});
