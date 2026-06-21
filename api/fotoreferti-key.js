import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';

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
    `${supabaseUrl}/rest/v1/medici?user_id=eq.${encodeURIComponent(userData.id)}&select=id,stato,referti_dek`,
    { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
  ).catch(() => null);
  if (!medicoRes || !medicoRes.ok) {
    return res.status(403).json({ error: 'Verifica account fallita' });
  }
  const medicoData = await medicoRes.json().catch(() => []);
  if (!medicoData?.[0] || medicoData[0].stato !== 'approvato') {
    return res.status(403).json({ error: 'Account non autorizzato' });
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

      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/medici?id=eq.${encodeURIComponent(medicoId)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': serviceKey,
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ referti_dek: wrapped })
        }
      ).catch(() => null);
      if (!patchRes || !patchRes.ok) {
        return res.status(500).json({ error: 'Si è verificato un errore. Riprova.' });
      }

      dek = Buffer.from(gen.Plaintext).toString('base64');
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
