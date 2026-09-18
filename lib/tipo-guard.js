// lib/tipo-guard.js
// Guardia condivisa sul tipo di visita per le prenotazioni che arrivano dal client
// (booking pubblico, link del centro, plancia cooperativa). Il filtro per centro
// (tipi_visita.centri_esclusi) viveva solo nel client: qui diventa arbitro server.
// Regole:
//  - tipo vuoto: ammesso (invariato, la tendina coop lo consente);
//  - medico senza catalogo tipi_visita: nessun vincolo (nessuna esclusione possibile;
//    la plancia coop in quel caso propone i servizi della cooperativa);
//  - catalogo presente: il tipo deve esistere nel catalogo del medico e NON essere
//    escluso per il centro, altrimenti 400.
// Fail-closed: lettura del catalogo fallita -> 502, come slot-guard.
// `sb(path)` e il wrapper PostgREST service-role dell'endpoint chiamante.
// Ritorna { ok:true } oppure { ok:false, status, error }.

const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

export function tipoAmmesso(catalogo, centroId, tipo) {
  const t = norm(tipo);
  if (!t) return true;
  if (!Array.isArray(catalogo) || catalogo.length === 0) return true;
  const rec = catalogo.find(r => norm(r.nome) === t);
  if (!rec) return false;
  return !((rec.centri_esclusi || []).map(String).includes(String(centroId)));
}

export async function verificaTipo({ sb, medicoId, centroId, tipo }) {
  if (!norm(tipo)) return { ok: true };
  let catalogo;
  try {
    const r = await sb(`tipi_visita?medico_id=eq.${encodeURIComponent(medicoId)}&select=nome,centri_esclusi`);
    if (!r.ok) return { ok: false, status: 502, error: 'Verifica prestazione non riuscita' };
    catalogo = await r.json();
    if (!Array.isArray(catalogo)) return { ok: false, status: 502, error: 'Verifica prestazione non riuscita' };
  } catch {
    return { ok: false, status: 502, error: 'Verifica prestazione non riuscita' };
  }
  if (!tipoAmmesso(catalogo, centroId, tipo)) {
    return { ok: false, status: 400, error: 'Prestazione non disponibile in questo centro' };
  }
  return { ok: true };
}
