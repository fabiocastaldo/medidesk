// Espone solo URL e anon key pubblica al client same-origin (medidesk.html, cooperativa.html).
// Nessun header CORS: nessun altro dominio deve poterla leggere (T-05).
export default function handler(req, res) {
  res.json({
    url:     process.env.SUPABASE_URL      || '',
    anonKey: process.env.SUPABASE_ANON_KEY || ''
  });
}
