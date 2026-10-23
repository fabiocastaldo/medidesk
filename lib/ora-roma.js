// lib/ora-roma.js
// C-10 (riesame 22/10/2026, s94): data e ora degli appuntamenti sono ore di Roma, mentre il
// runtime delle funzioni gira in UTC. new Date(`${data}T${ora}:00`) le leggeva come UTC e
// spostava i termini di una o due ore secondo l'ora legale. Qui l'istante vero.
const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// Scarto di Roma rispetto a UTC (ms) nell'istante dato
function scartoRoma(istante) {
  const p = Object.fromEntries(FMT.formatToParts(istante).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(istante.getTime() / 60000) * 60000;
}

// istanteRoma('2026-10-23', '10:00') → Date dell'istante in cui a Roma sono le 10:00 di quel giorno.
// Ritorna una Date non valida se data/ora non sono nel formato atteso.
export function istanteRoma(data, ora) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || '')) || !/^\d{2}:\d{2}/.test(String(ora || ''))) return new Date(NaN);
  const comeUtc = new Date(`${data}T${String(ora).substring(0, 5)}:00Z`);
  if (Number.isNaN(comeUtc.getTime())) return comeUtc;
  const primo = new Date(comeUtc.getTime() - scartoRoma(comeUtc));
  // secondo passo: attorno al cambio d'ora lo scarto va letto nell'istante corretto
  return new Date(comeUtc.getTime() - scartoRoma(primo));
}
