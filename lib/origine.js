// lib/origine.js — C-07 (riesame grey box, s93): l'host con cui il server costruisce link nelle email e chiama i
// propri endpoint non viene mai preso dagli header della richiesta (x-forwarded-host / host), ma dall'ambiente del
// deploy: in produzione il dominio canonico, sulle anteprime l'URL del deploy fornito da Vercel (VERCEL_URL).
export function hostFidato() {
  if (process.env.VERCEL_ENV === 'production') return 'www.delphi-med.com';
  const u = String(process.env.VERCEL_URL || '').trim();
  return /^[a-z0-9.-]+\.vercel\.app$/.test(u) ? u : 'www.delphi-med.com';
}
