import { Chip, Tooltip } from '@mui/material';
import type { FileItem } from '../types';

export default function DocumentAnalysis({ analysis }: { analysis?: FileItem['analysis'] }) {
  if (!analysis) return null;
  const labels = { pending: 'Analyse en attente', processing: 'Extraction en cours', ready: 'Texte disponible', blocked: 'Analyse bloquée' };
  return <Tooltip title={analysis.error ?? (analysis.status === 'ready' ? 'Le texte sera contrôlé par LinGuard avant chaque envoi à l’IA.' : 'Extraction locale du texte et OCR si nécessaire.')}>
    <Chip component="span" size="small" label={labels[analysis.status]} color={analysis.status === 'blocked' ? 'warning' : 'default'} sx={{ maxWidth: '100%', height: 22, fontSize: '0.68rem', mt: 0.3 }} />
  </Tooltip>;
}
