// api/medico.js — iniezione meta/JSON-LD server-side per la pagina pubblica /m/:slug
// Usa SOLO la anon key + la RPC get_medico_pubblico (campi pubblici) e SELECT centri sotto RLS. Mai service_role.

const CANONICAL_BASE = 'https://www.delphi-med.com';
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const slug = String((req.query && req.query.slug) || '').trim().toLowerCase();

  // shell statica, deployment-agnostica (niente fs): la rotta /medidesk.html serve il file reale
  let shell;
  try {
    const sr = await fetch(`https://${req.headers.host}/medidesk.html`);
    shell = await sr.text();
  } catch (e) {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(200).send('<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>Delphi~Med</title></head><body></body></html>');
  }
  const serveShell = (status) => { res.setHeader('Content-Type','text/html; charset=utf-8'); return res.status(status).send(shell); };
  if (!url || !anonKey || !slug) return serveShell(200);

  // 1) medico (anon + RPC)
  let m = null;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/get_medico_pubblico`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','apikey':anonKey,'Authorization':`Bearer ${anonKey}` },
      body: JSON.stringify({ p_slug: slug })
    });
    const arr = await r.json();
    m = Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch (e) { m = null; }
  if (!m) return serveShell(404); // slug inesistente: 404 reale, body = SPA che mostra "non trovato"

  // 2) centri attivi (anon, RLS pubblica)
  let centri = [];
  try {
    const r = await fetch(`${url}/rest/v1/centri?medico_id=eq.${encodeURIComponent(m.id)}&attivo=eq.true&select=nome,via,citta,provincia,cap,turni(giorno,inizio,fine)`, {
      headers:{ 'apikey':anonKey,'Authorization':`Bearer ${anonKey}` }
    });
    const arr = await r.json();
    if (Array.isArray(arr)) centri = arr;
  } catch (e) { centri = []; }

  // 3) derivazioni
  const fullName = [m.titolo, m.nome, m.cognome].filter(Boolean).join(' ').trim() || 'Medico';
  const specPrimaria = m.specializzazione || (Array.isArray(m.specializzazioni) && m.specializzazioni[0]) || '';
  const cittaPrim = (centri.find(c => c.citta) || {}).citta || '';
  const canonical = `${CANONICAL_BASE}/m/${encodeURIComponent(slug)}`;
  const fotoAbs = (m.foto_url && /^https?:\/\//i.test(m.foto_url)) ? m.foto_url : '';

  let title = [fullName, specPrimaria].filter(Boolean).join(', ');
  if (cittaPrim) title += ` a ${cittaPrim}`;
  title += ' | Prenota online';

  const bioSrc = (m.bio_lunga || m.bio || '').replace(/\s+/g,' ').trim();
  const description = bioSrc
    ? (bioSrc.length > 155 ? bioSrc.slice(0,152).trimEnd() + '…' : bioSrc)
    : `Prenota online una visita con ${fullName}${specPrimaria ? ', ' + specPrimaria : ''}${cittaPrim ? ' a ' + cittaPrim : ''}.`;

  // 4) JSON-LD @graph
  const sameAs = [m.sito_web, m.linkedin, m.instagram, m.youtube, m.facebook].filter(Boolean);
  const lingue = Array.isArray(m.lingue) ? m.lingue.filter(Boolean) : [];
  const specialties = [...new Set([m.specializzazione, ...(Array.isArray(m.specializzazioni)?m.specializzazioni:[])].filter(Boolean))];
  const postal = (c) => ({ '@type':'PostalAddress', streetAddress:c.via||undefined, addressLocality:c.citta||undefined, postalCode:c.cap||undefined, addressRegion:c.provincia||undefined, addressCountry:'IT' });
  const openingSpec = (c) => (Array.isArray(c.turni)?c.turni:[])
    .filter(t => t && t.giorno != null && t.inizio && t.fine)
    .map(t => ({ '@type':'OpeningHoursSpecification', dayOfWeek:`https://schema.org/${DOW[t.giorno]||'Monday'}`, opens:String(t.inizio).slice(0,5), closes:String(t.fine).slice(0,5) }));

  const physicianId = canonical + '#physician';
  const physician = {
    '@type':['Physician','MedicalBusiness'], '@id':physicianId, name:fullName, url:canonical,
    image: fotoAbs || undefined,
    medicalSpecialty: specialties.length ? specialties : undefined,
    telephone: m.telefono || undefined, email: m.email_pubblica || undefined,
    knowsLanguage: lingue.length ? lingue : undefined,
    sameAs: sameAs.length ? sameAs : undefined,
    areaServed: [...new Set(centri.map(c=>c.citta).filter(Boolean))],
    address: centri.length ? postal(centri[0]) : undefined,
    location: centri.map(c => ({ '@type':'MedicalClinic', name:c.nome||fullName, address:postal(c), openingHoursSpecification:openingSpec(c) }))
  };
  if (m.numero_iscrizione_ordine) {
    physician.identifier = { '@type':'PropertyValue', name:'Iscrizione Albo dei Medici' + (m.provincia_ordine ? ' di ' + m.provincia_ordine : ''), value:m.numero_iscrizione_ordine };
  }
  const person = { '@type':'Person', '@id':canonical+'#person', name:fullName, image:fotoAbs||undefined, jobTitle:specPrimaria||undefined, knowsLanguage:lingue.length?lingue:undefined, worksFor:{ '@id':physicianId } };
  const breadcrumb = { '@type':'BreadcrumbList', itemListElement:[
    { '@type':'ListItem', position:1, name:'Home', item:CANONICAL_BASE+'/' },
    { '@type':'ListItem', position:2, name:fullName, item:canonical }
  ]};
  const graph = { '@context':'https://schema.org', '@graph':[physician, person, breadcrumb] };
  const jsonLd = JSON.stringify(graph).replace(/</g,'\\u003c'); // anti-breakout dal tag <script>

  // 5) iniezione nel <head> (sostituisce l'unico <title>Delphi~Med</title> della shell)
  const head = `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Delphi~Med">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">${fotoAbs ? `\n<meta property="og:image" content="${esc(fotoAbs)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">${fotoAbs ? `\n<meta name="twitter:image" content="${esc(fotoAbs)}">` : ''}
<script type="application/ld+json">${jsonLd}</script>`;

  const out = shell.replace('<title>Delphi~Med</title>', head);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(out);
}
