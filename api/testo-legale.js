// api/testo-legale.js — testo integrale di un documento legale accettato, dall'archivio a sola aggiunta
// public.testi_legali (piano privacy riga 53, s70). GET ?hash=<sha256>, con il token di sessione del medico.
// Risposta text/html con CSP chiusa (nessuno script, nessuna risorsa esterna), nosniff, no-store; 401 senza token valido, 404 generico
// su hash non valido o non archiviato.
import { richiediAal2 } from '../lib/aal-guard.js';

export default async function handler(req, res) {
  const nf = () => res.status(404).json({ error: 'not_found' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Configurazione server mancante' });

  const hash = String(req.query?.hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return nf();

  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!jwt) return res.status(401).json({ error: 'Non autenticato' });
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${jwt}` } }).catch(() => null);
  if (!userRes || !userRes.ok) return res.status(401).json({ error: 'Non autenticato' });
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) return res.status(401).json({ error: 'Non autenticato' });
  const aalKo = richiediAal2(jwt, userData);
  if (aalKo) return res.status(aalKo.status).json({ error: aalKo.error, code: aalKo.code });

  const r = await fetch(`${supabaseUrl}/rest/v1/testi_legali?hash_testo=eq.${hash}&select=testo`, {
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
  }).catch(() => null);
  const rows = r && r.ok ? await r.json().catch(() => []) : [];
  if (!rows[0]?.testo) return nf();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  return res.status(200).send(rows[0].testo);
}
