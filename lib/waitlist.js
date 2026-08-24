// lib/waitlist.js
// Hook lista d'attesa condiviso (v1) — estratto da api/cancel-appointment.js e
// api/coop-cancella.js, che lo replicavano riga per riga.
// Avvisa gli iscritti attivi dello stesso medico+centro il cui appuntamento
// (non cancellato) è a data/ora successiva allo slot liberato. Solo slot futuri,
// best-effort, soft-fail totale, cap 10 destinatari per cancellazione.
// `sb` è il client PostgREST service-role dell'endpoint chiamante; `host` il
// forwarded-host per richiamare /api/send-email; `appt` la riga appena cancellata.
export async function avvisaListaAttesa({ sb, host, appt }) {
  try {
    if (!host || !appt || !appt.medico_id || !appt.data) return;
    const oraSlot = String(appt.ora || '00:00').slice(0, 5);
    const slotTs = `${appt.data}T${oraSlot}`;
    const now = new Date();
    const nowTs = now.toLocaleDateString('en-CA') + 'T' +
                  String(now.getHours()).padStart(2, '0') + ':' +
                  String(now.getMinutes()).padStart(2, '0');
    if (slotTs <= nowTs) return; // solo slot futuri
    const q = `lista_attesa?attivo=eq.true&medico_id=eq.${encodeURIComponent(appt.medico_id)}` +
              (appt.centro_id ? `&centro_id=eq.${encodeURIComponent(appt.centro_id)}` : '') +
              `&select=id,appuntamento_id,appuntamenti!inner(id,data,ora,cancelled,cancellation_token)` +
              `&appuntamenti.cancelled=eq.false&limit=50`;
    const rw = await sb(q);
    if (!rw.ok) return;
    const subs = await rw.json().catch(() => []);
    const targets = (Array.isArray(subs) ? subs : [])
      .filter(s => {
        const a = s.appuntamenti;
        if (!a || a.cancelled || !a.data) return false;
        const ts = `${a.data}T${String(a.ora || '00:00').slice(0, 5)}`;
        return ts > slotTs;
      })
      .slice(0, 10);
    for (const s of targets) {
      await fetch(`https://${host}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'avviso_lista_attesa',
          appt_id: s.appuntamenti.id,
          cancellation_token: s.appuntamenti.cancellation_token,
          slot_data: appt.data,
          slot_ora: oraSlot
        })
      }).catch(() => {});
      await sb(`lista_attesa?id=eq.${encodeURIComponent(s.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ notified_at: new Date().toISOString() })
      }).catch(() => {});
    }
  } catch { /* soft-fail */ }
}
