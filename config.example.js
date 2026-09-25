// Copia questo file in config.js e sostituisci i valori con le tue credenziali Supabase.
// Trovi URL e anon key in: Supabase Dashboard → Project Settings → API
window.SUPABASE_CONFIG = {
  url:     'https://YOUR_PROJECT.supabase.co',
  anonKey: 'sb_publishable_YOUR_KEY'
};

// Su Vercel, aggiungi le seguenti variabili d'ambiente nel pannello del progetto:
//   SUPABASE_URL        = https://YOUR_PROJECT.supabase.co
//   SUPABASE_PUBLISHABLE_KEY = sb_publishable_YOUR_KEY
//   SUPABASE_SECRET_KEY      = sb_secret_YOUR_KEY   (solo server, mai nel client)
//   ANTHROPIC_API_KEY   = sk-ant-your-key-here
