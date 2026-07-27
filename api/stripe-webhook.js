// api/stripe-webhook.js — webhook Stripe (TEST MODE). Node-style handler (req, res) per raw body deterministico.
// Idempotente: lo stato dell'abbonamento viene riletto da Stripe (subscriptions.retrieve),
// mai dedotto dal payload dell'evento, che puo' essere stale su replay o consegna fuori ordine.
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

  // Guardia per-medico: subscriptions ha una riga sola per medico (on_conflict=medico_id).
  // Un evento terminale in ritardo su una subscription gia' superata la riscriverebbe
  // all'indietro. Se la riga punta a un'altra subscription ancora viva, l'evento si ignora.
  // Headers dedicati: sHeaders porta Prefer return=minimal, che su GET puo' svuotare il corpo.
  if (isDeleted) {
    const rGet = await fetch(
      `${base}/subscriptions?medico_id=eq.${encodeURIComponent(medicoId)}&select=stripe_subscription_id,status`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!rGet.ok) throw new Error(`get subscriptions ${rGet.status}: ${await rGet.text().catch(() => '')}`);
    const rows = await rGet.json().catch(() => null);
    const cur  = Array.isArray(rows) ? rows[0] : null;
    const curTerminale = !cur || cur.status === 'canceled' || cur.status === 'incomplete_expired';
    if (cur && cur.stripe_subscription_id && cur.stripe_subscription_id !== sub.id && !curTerminale) {
      console.warn('[stripe-webhook] evento terminale su subscription superata, ignorato:', JSON.stringify({
        evento:       sub.id,
        eventoStatus: sub.status,
        riga:         cur.stripe_subscription_id,
        rigaStatus:   cur.status,
        medico:       medicoId
      }));
      return;
    }
  }

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

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET mancante');
    return res.status(500).send('Server misconfiguration');
  }
  const sig = req.headers['stripe-signature'];
  const rawBody = await readRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error('[stripe-webhook] firma non valida:', err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subId = event.data.object?.id;
        if (!subId) {
          console.warn('[stripe-webhook] evento senza subscription id, ignorato:', event.id);
          break;
        }
        // Lo stato corrente lo chiede a Stripe, non lo deduce dall'evento:
        // il payload puo' essere gia' superato (replay o consegna fuori ordine).
        // Cosi' la scrittura e' idempotente per costruzione.
        const fresh = await stripe.subscriptions.retrieve(subId);
        await applySubscription(fresh);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err.message);
    return res.status(500).send('Webhook handler error');
  }

  return res.status(200).json({ received: true });
}
