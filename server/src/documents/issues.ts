export type DocumentIssueCategory = 'service' | 'document' | 'limit' | 'unsupported' | 'unknown';

const definitions = {
  'service-unreachable': ['service', 'Service documentaire injoignable', 'Vérifier le service documentaire, puis réessayer l’analyse.', true],
  'service-http': ['service', 'Échec du service documentaire', 'Vérifier le service et ses journaux, puis réessayer.', true],
  'service-busy': ['service', 'Service documentaire occupé', 'Attendre la fin des analyses en cours puis réessayer.', true],
  'invalid-response': ['service', 'Réponse du service invalide', 'Vérifier la version et la configuration du service documentaire.', true],
  'service-config': ['service', 'Configuration documentaire incorrecte', 'Faire vérifier la configuration du service documentaire puis relancer l’extraction.', true],
  timeout: ['service', 'Délai d’extraction dépassé', 'Réessayer après vérification du service ; scinder le document si le délai se répète.', true],
  cancelled: ['service', 'Extraction interrompue', 'Réessayer l’analyse lorsque le service est disponible.', true],
  'size-limit': ['limit', 'Limite documentaire atteinte', 'Réduire ou scinder le document puis le déposer à nouveau.', false],
  'page-limit': ['limit', 'Trop de pages', 'Scinder le PDF en documents de 20 pages maximum.', false],
  'text-limit': ['limit', 'Texte trop volumineux', 'Scinder le document pour rester sous 200 000 caractères.', false],
  'storage-limit': ['limit', 'Espace de stockage insuffisant', 'Libérer de l’espace puis réessayer.', true],
  encrypted: ['document', 'Document chiffré', 'Fournir une copie déchiffrée du document.', false],
  unreadable: ['document', 'Document illisible ou protégé', 'Fournir une copie déchiffrée, un scan plus net ou une version texte.', false],
  empty: ['document', 'Aucun texte exploitable', 'Fournir un scan plus net ou une version texte du document.', false],
  partial: ['document', 'Extraction incomplète', 'Scinder le document ou fournir une version texte ; aucune extraction partielle ne sera envoyée.', false],
  unsupported: ['unsupported', 'Format non pris en charge', 'Fournir un PDF, une image lisible, un document bureautique ou une transcription texte.', false],
  missing: ['document', 'Fichier introuvable', 'Sélectionner un document encore disponible dans ce salon.', false],
  pending: ['service', 'Analyse encore en attente', 'Attendre la fin de l’extraction puis réessayer la demande.', true],
  unknown: ['unknown', 'Échec d’extraction à préciser', 'Vérifier le service puis relancer l’analyse pour obtenir un diagnostic précis.', true],
} as const;

export type DocumentIssueCode = keyof typeof definitions;
export interface DocumentIssue {
  stage: 'extraction';
  category: DocumentIssueCategory;
  code: DocumentIssueCode;
  title: string;
  message: string;
  action: string;
  retryable: boolean;
  diagnostic?: { httpStatus?: number; networkCode?: string };
}

export function documentIssue(code: DocumentIssueCode, message: string, diagnostic?: DocumentIssue['diagnostic']): DocumentIssue {
  const [category, title, action, retryable] = definitions[code];
  return { stage: 'extraction', category, code, title, message, action, retryable, ...(diagnostic ? { diagnostic } : {}) };
}

// Les anciens échecs ne contiennent pas de code : ne pas transformer une cause
// ambiguë en diagnostic certain. Une relance remplacera cette information.
export function legacyDocumentIssue(message: string | null): DocumentIssue {
  return documentIssue('unknown', message ?? 'La cause de cette ancienne extraction n’a pas été enregistrée.');
}

export function restoreDocumentIssue(json: string | null | undefined, message: string | null): DocumentIssue {
  try {
    const value = JSON.parse(json ?? 'null') as DocumentIssue | null;
    if (value && Object.hasOwn(definitions, value.code)) return documentIssue(value.code, message ?? value.message, value.diagnostic);
  } catch { /* ancien format ou valeur illisible */ }
  return legacyDocumentIssue(message);
}
