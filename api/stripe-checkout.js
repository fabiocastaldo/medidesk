// api/stripe-checkout.js — crea Stripe Checkout Session (TEST MODE) per il medico autenticato.
// Auth: stesso pattern di genera-referto (JWT -> auth/v1/user -> medici by user_id). Chiavi TEST.
import Stripe from 'stripe';

const PRICE_MAP = {
  'pro:month':      'STRIPE_PRICE_PRO_MONTH',
  'pro:year':       'STRIPE_PRICE_PRO_YEAR',
  'studio:month':   'STRIPE_PRICE_STUDIO_MONTH',
  'studio:year':    'STRIPE_PRICE_STUDIO_YEAR',
  'founding:month': 'STRIPE_PRICE_FOUNDING_MONTH'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  const stripeKey   = process.env.STRIPE_SECRET_KEY;
  const appBase     = process.env.APP_BASE_URL || 'https://www.delphi-med.com';
  if (!supabaseUrl || !serviceKey || !anonKey || !stripeKey) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,piano`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  const medicoId = medicoData?.[0]?.id;
  if (!medicoId) {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }

  if (medicoData[0].piano === 'founding') {
    return res.status(403).json({ error: 'Il piano Founding non prevede il passaggio a Pro. Per cambiare piano disdici e iscriviti al listino corrente.' });
  }
  if (medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non ancora approvato' });
  }

  if (medicoData[0].piano === 'vip') {
    return res.status(403).json({ error: 'Il tuo piano non prevede abbonamenti a pagamento' });
  }

  const body = req.body || {};
  const piano = String(body.piano || '').trim();
  let intervallo = String(body.intervallo || 'month').trim();
  if (piano === 'founding') intervallo = 'month';
  const envName = PRICE_MAP[`${piano}:${intervallo}`];
  if (!envName) {
    return res.status(400).json({ error: 'Piano o intervallo non valido' });
  }
  const priceId = process.env[envName];
  if (!priceId) {
    if (piano === 'founding') {
      return res.status(403).json({ error: 'Offerta Founding esaurita', code: 'FOUNDING_SOLD_OUT' });
    }
    console.error('[stripe-checkout] price non configurato per', piano, intervallo);
    return res.status(500).json({ error: 'Piano temporaneamente non disponibile' });
  }

  const stripe = new Stripe(stripeKey);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appBase}/?sub=success`,
      cancel_url:  `${appBase}/?sub=cancel`,
      client_reference_id: medicoId,
      metadata: { medico_id: medicoId, piano },
      subscription_data: { metadata: { medico_id: medicoId, piano } }
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[stripe-checkout] session error:', err.message);
    return res.status(500).json({ error: 'Creazione checkout fallita' });
  }
}
