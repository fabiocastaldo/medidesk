// api/stripe-portal.js — crea Stripe Billing Portal Session (TEST MODE) per il medico autenticato.
// Auth: stesso pattern di stripe-checkout (JWT -> auth/v1/user -> medici by user_id).
// Nessun gate su stato/piano: la gestione dell'abbonamento e il recesso non si subordinano
// all'approvazione dell'account. Il gate reale e' il possesso di subscriptions.stripe_customer_id.
// Famiglia carve-out: non consuma il motore premium, mai gateato.
import Stripe from 'stripe';

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
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id`,
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

  const subRes = await fetch(
    `${supabaseUrl}/rest/v1/subscriptions?medico_id=eq.${encodeURIComponent(medicoId)}&select=stripe_customer_id`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!subRes || !subRes.ok) {
    return res.status(500).json({ error: 'Verifica abbonamento fallita' });
  }
  const subRows = await subRes.json().catch(() => []);
  const customerId = subRows?.[0]?.stripe_customer_id;
  if (!customerId) {
    return res.status(409).json({ error: 'Nessun abbonamento da gestire' });
  }

  const stripe = new Stripe(stripeKey);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appBase}/`
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[stripe-portal] session error:', err.message);
    return res.status(500).json({ error: 'Apertura del portale fallita' });
  }
}
