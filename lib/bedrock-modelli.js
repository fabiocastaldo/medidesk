// Elenco chiuso dei profili Bedrock e della regione ammessi (piano privacy riga 50, s70; A06 § 3, V02 § 3-sexvicies).
// Un valore di ambiente fuori da questo elenco non viene usato: l'endpoint fallisce prima di chiamare il modello.
// Ogni cambio di modello, profilo o regione passa da qui, nello stesso commit, con aggiornamento dei documenti.
export const PROFILI_BEDROCK = Object.freeze([
  'eu.anthropic.claude-sonnet-4-6',                 // analisi referti, referto, comunicazioni, agenda importata, presentazione
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0'     // assistente integrato
]);
export const REGIONE_BEDROCK = 'eu-central-1';

// Variabile di ambiente → profilo predefinito (gli endpoint non portano letterali di modello)
export const PREDEFINITI = Object.freeze({
  BEDROCK_MODEL_ID: PROFILI_BEDROCK[0],
  BEDROCK_ASSISTANT_MODEL_ID: PROFILI_BEDROCK[1]
});

export function profiloBedrock(nomeEnv) {
  const v = String(process.env[nomeEnv] || PREDEFINITI[nomeEnv] || '').trim();
  if (!PROFILI_BEDROCK.includes(v)) throw new Error(`profilo Bedrock non ammesso (${nomeEnv}=${v || 'vuoto'})`);
  return v;
}

export function regioneBedrock() {
  const r = String(process.env.AWS_REGION || REGIONE_BEDROCK).trim();
  if (r !== REGIONE_BEDROCK) throw new Error(`regione Bedrock non ammessa (AWS_REGION=${r})`);
  return r;
}
