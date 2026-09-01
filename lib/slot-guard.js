// lib/slot-guard.js
// Guardia di copertura condivisa per le prenotazioni anonime (booking pubblico e
// link del centro): lo slot richiesto deve essere offerto da un turno attivo del
// centro (giorno, validita dal/al, frequenza, allineamento alla griglia durata_slot)
// oppure da una giornata singola (disponibilita_singole) sulla stessa data, e il
// medico non deve essere in chiusura su quella data per quel centro.
// Stessa semantica del client (getSlots) piu il "dal" che il client non applica.
// `sb(path)` e il wrapper PostgREST service-role dell'endpoint chiamante.
// Ritorna { ok:true } oppure { ok:false, status, error }.

const t2m = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const inGriglia = (oraMin, inizio, fine, durata) => {
  const ini = t2m(String(inizio).slice(0, 5));
  const fin = t2m(String(fine).slice(0, 5));
  const slot = Number(durata) || 0;
  if (!slot) return false;
  return oraMin >= ini && (oraMin - ini) % slot === 0 && oraMin + slot <= fin;
};

export async function verificaSlot({ sb, medicoId, centroId, data, ora }) {
  const enc = encodeURIComponent;
  let turni, singole, chiusure;
  try {
    const [tR, sR, cR] = await Promise.all([
      sb(`turni?centro_id=eq.${enc(centroId)}&select=giorno,inizio,fine,durata_slot,frequenza_settimane,data_inizio_validita,data_fine_validita`),
      sb(`disponibilita_singole?centro_id=eq.${enc(centroId)}&data=eq.${enc(data)}&select=inizio,fine,durata_slot`),
      sb(`chiusure?medico_id=eq.${enc(medicoId)}&data_inizio=lte.${enc(data)}&data_fine=gte.${enc(data)}&select=centri_ids`)
    ]);
    if (!tR.ok || !sR.ok || !cR.ok) return { ok: false, status: 502, error: 'Verifica disponibilita non riuscita' };
    turni = await tR.json(); singole = await sR.json(); chiusure = await cR.json();
    if (!Array.isArray(turni) || !Array.isArray(singole) || !Array.isArray(chiusure)) {
      return { ok: false, status: 502, error: 'Verifica disponibilita non riuscita' };
    }
  } catch {
    return { ok: false, status: 502, error: 'Verifica disponibilita non riuscita' };
  }

  const inFerie = chiusure.some(ch => {
    const ids = ch.centri_ids || [];
    return ids.length === 0 || ids.some(cid => String(cid) === String(centroId));
  });
  if (inFerie) return { ok: false, status: 422, error: 'Il medico \u00e8 chiuso per ferie in questa data' };

  const dow = new Date(data + 'T12:00:00').getDay();
  const oraMin = t2m(ora);
  const daTurno = turni.some(t => {
    if (t.giorno !== dow) return false;
    const dal = t.data_inizio_validita || null;
    const al  = t.data_fine_validita || null;
    if (dal && data < dal) return false;
    if (al && data > al) return false;
    const freq = t.frequenza_settimane || 1;
    if (freq > 1 && dal) {
      const diffW = Math.round((new Date(data + 'T12:00:00') - new Date(dal + 'T12:00:00')) / (7 * 24 * 3600 * 1000));
      if (diffW < 0 || diffW % freq !== 0) return false;
    }
    return inGriglia(oraMin, t.inizio, t.fine, t.durata_slot);
  });
  const daSingola = singole.some(g => inGriglia(oraMin, g.inizio, g.fine, g.durata_slot));
  if (!daTurno && !daSingola) return { ok: false, status: 422, error: 'Nessun turno attivo copre questo orario' };
  return { ok: true };
}
