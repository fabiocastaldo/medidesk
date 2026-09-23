import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { trialExpired } from '../lib/trial-gate.js';

const kms = new KMSClient({ region: process.env.AWS_REGION || 'eu-central-1' });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticazione richiesta' });
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey     = process.env.SUPABASE_ANON_KEY;
  const keyId       = process.env.KMS_KEY_ID;
  if (!supabaseUrl || !serviceKey || !anonKey || !keyId) {
    return res.status(500).json({ error: 'Configurazione server mancante' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': anonKey }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
  const userData = await userRes.json().catch(() => null);
  if (!userData?.id) {
    return res.status(401).json({ error: 'Utente non riconosciuto' });
  }

  const medicoRes = await fetch(
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,referti_dek,piano,created_at`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
  }
  if (trialExpired(medicoData[0].piano, medicoData[0].created_at)) {
    return res.status(403).json({ error: 'Periodo di prova scaduto', code: 'TRIAL_EXPIRED' });
  }
  const medico = medicoData[0];
  const medicoId = String(medico.id);

  try {
    let dek;

    if (!medico.referti_dek) {
      const gen = await kms.send(new GenerateDataKeyCommand({
        KeyId: keyId,
        KeySpec: 'AES_256',
        EncryptionContext: { medico_id: medicoId }
      }));
      const wrapped = Buffer.from(gen.CiphertextBlob).toString('base64');

      // Scrittura condizionale: la chiave si salva SOLO se la colonna è ancora vuota.
      // Due chiamate concorrenti al primo accesso non devono mai sovrascriversi a vicenda:
      // chi perde la corsa rilegge la chiave vinta e la decifra, invece di imporne una nuova.
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/medici?id=eq.${encodeURIComponent(medicoId)}&referti_dek=is.null`,
        {
          method: 'PATCH',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ referti_dek: wrapped })
        }
      ).catch(() => null);
      if (!patchRes || !patchRes.ok) {
        return res.status(500).json({ error: 'Si è verificato un errore. Riprova.' });
      }
      const patched = await patchRes.json().catch(() => []);
      if (Array.isArray(patched) && patched.length) {
        dek = Buffer.from(gen.Plaintext).toString('base64');
      } else {
        const reRes = await fetch(
          `${supabaseUrl}/rest/v1/medici?id=eq.${encodeURIComponent(medicoId)}&select=referti_dek`,
          { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
        ).catch(() => null);
        const vinta = (reRes && reRes.ok) ? (await reRes.json().catch(() => []))?.[0]?.referti_dek : null;
        if (!vinta) {
          return res.status(500).json({ error: 'Si è verificato un errore. Riprova.' });
        }
        const dec = await kms.send(new DecryptCommand({
          CiphertextBlob: Buffer.from(vinta, 'base64'),
          EncryptionContext: { medico_id: medicoId },
          KeyId: keyId
        }));
        dek = Buffer.from(dec.Plaintext).toString('base64');
      }
    } else {
      const dec = await kms.send(new DecryptCommand({
        CiphertextBlob: Buffer.from(medico.referti_dek, 'base64'),
        EncryptionContext: { medico_id: medicoId },
        KeyId: keyId
      }));
      dek = Buffer.from(dec.Plaintext).toString('base64');
    }

    return res.status(200).json({ dek });
  } catch (err) {
    console.error('fotoreferti-key error:', err);
    return res.status(500).json({ error: 'Si è verificato un errore. Riprova.' });
  }
}
