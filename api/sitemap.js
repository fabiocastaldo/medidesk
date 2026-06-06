// api/sitemap.js — sitemap XML dinamica dei medici approvati (anon + RPC get_sitemap_medici)
const CANONICAL_BASE = 'https://www.delphi-med.com';

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  let rows = [];
  try {
    const r = await fetch(`${url}/rest/v1/rpc/get_sitemap_medici`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','apikey':anonKey,'Authorization':`Bearer ${anonKey}` },
      body:'{}'
    });
    const arr = await r.json();
    if (Array.isArray(arr)) rows = arr;
  } catch (e) { rows = []; }

  const xmlEsc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const urls = [
    `  <url><loc>${CANONICAL_BASE}/</loc></url>`,
    ...rows.filter(x => x && x.slug).map(x => {
      const loc = `${CANONICAL_BASE}/m/${encodeURIComponent(x.slug)}`;
      const lastmod = x.data_modifica_profilo ? String(x.data_modifica_profilo).slice(0,10) : '';
      return `  <url><loc>${xmlEsc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
    })
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
  res.setHeader('Content-Type','application/xml; charset=utf-8');
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).send(xml);
}
