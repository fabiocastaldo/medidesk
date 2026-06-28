// api/stripe-webhook.js — webhook Stripe (TEST MODE). Web-style handler per raw body deterministico.
// Verifica firma via SDK, poi upsert subscriptions + gating medici via PostgREST service_role.
// Gestisce customer.subscription.created/updated/deleted; 200 sul resto (no retry storm).
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function tsToIso(sec) {
  return (typeof sec === 'number' && sec > 0) ? new Date(sec * 1000).toISOString() : null;
}

async function applySubscription(sub) {
  const medicoId = sub?.metadata?.medico_id;
  if (!medicoId) {
    console.warn('[stripe-webhook] subscription senza medico_id, ignorata:', sub?.id);
    return;
  }
  const item      = sub.items?.data?.[0];
  const price     = item?.price;
  const periodEnd = tsToIso(sub.current_period_end ?? item?.current_period_end);
  const isDeleted = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  const pianoEff  = isDeleted ? 'free' : (sub?.metadata?.piano || 'free');

  const base = `${process.env.SUPABASE_URL}/rest/v1`;
  const sHeaders = {
    'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'resolution=merge-duplicates,return=minimal'
  };
  const nowIso = new Date().toISOString();

  const r1 = await fetch(`${base}/subscriptions?on_conflict=medico_id`, {
    method: 'POST',
    headers: sHeaders,
    body: JSON.stringify({
      medico_id:              medicoId,
      stripe_customer_id:     typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id || null),
      stripe_subscription_id: sub.id,
      piano:                  pianoEff,
      status:                 sub.status || null,
      prezzo:                 (price?.unit_amount != null) ? price.unit_amount / 100 : null,
      valuta:                 price?.currency || 'eur',
      intervallo:             price?.recurring?.interval || null,
      current_period_end:     periodEnd,
      cancel_at_period_end:   !!sub.cancel_at_period_end,
      updated_at:             nowIso
    })
  });
  if (!r1.ok) throw new Error(`upsert subscriptions ${r1.status}: ${await r1.text().catch(() => '')}`);

  const r2 = await fetch(`${base}/medici?id=eq.${encodeURIComponent(medicoId)}`, {
    method: 'PATCH',
    headers: sHeaders,
    body: JSON.stringify({
      piano:              pianoEff,
      sub_status:         isDeleted ? 'canceled' : (sub.status || null),
      current_period_end: isDeleted ? null : periodEnd
    })
  });
  if (!r2.ok) throw new Error(`patch medici ${r2.status}: ${await r2.text().catch(() => '')}`);
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response('Server misconfiguration', { status: 500 });
  }
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error('[stripe-webhook] firma non valida:', err.message);
    return new Response(`Webhook signature error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(event.data.object);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', event.type, err.message);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
