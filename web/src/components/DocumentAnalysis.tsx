import { Alert, AlertTitle, Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DocumentServiceHealth, FileItem } from '../types';

export default function DocumentAnalysis({ analysis, details = false }: { analysis?: FileItem['analysis']; details?: boolean }) {
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<DocumentServiceHealth | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => { setHealth(null); setCheckError(null); }, [analysis?.error, analysis?.status]);
  if (!analysis) return null;
  const issue = analysis.issue ?? { category: 'unknown', code: 'unknown', title: 'Échec d’extraction à préciser', message: analysis.error ?? 'Cause non enregistrée.', action: 'Vérifier le service puis relancer l’analyse pour obtenir un diagnostic précis.', retryable: true };
  const labels = { pending: 'Analyse en attente', processing: 'Extraction en cours', ready: 'Texte disponible', blocked: issue.title };
  const chip = <Tooltip title={analysis.error ?? (analysis.status === 'ready' ? 'Le texte sera contrôlé par LinGuard avant chaque envoi à l’IA.' : 'Extraction locale du texte et OCR si nécessaire.')}>
    <Chip component="span" size="small" label={labels[analysis.status]} color={analysis.status === 'blocked' ? issue.category === 'service' ? 'error' : 'warning' : 'default'} sx={{ maxWidth: '100%', height: 22, fontSize: '0.68rem', mt: 0.3 }} />
  </Tooltip>;
  if (!details || analysis.status !== 'blocked') return chip;
  return <Alert severity={issue.category === 'service' ? 'error' : 'warning'} sx={{ mt: 1, minWidth: 0, maxWidth: '100%', '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}>
    <AlertTitle>{issue.title}</AlertTitle>
    <Typography variant="body2">{issue.message}</Typography>
    <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 650 }}>Action : {issue.action}</Typography>
    <Typography variant="caption" display="block" sx={{ mt: 0.75 }}>Étape : extraction du texte. Le contrôle LinGuard reste à effectuer.</Typography>
    {(issue.category === 'service' || issue.category === 'unknown') && <Button size="small" color="inherit" disabled={checking} sx={{ mt: 0.75 }} onClick={() => {
      setChecking(true); setHealth(null); setCheckError(null);
      void api.documentService().then(setHealth).catch(() => setCheckError('Impossible de vérifier le service. Vérifier aussi la connexion à la chatroom.')).finally(() => setChecking(false));
    }}>{checking ? 'Vérification…' : 'Vérifier le service'}</Button>}
    {health && <Box role="status" sx={{ mt: 0.75 }}>
      <Typography variant="body2" sx={{ fontWeight: 650 }}>{health.available ? `Service joignable — Tika ${health.version}` : health.issue?.title ?? 'Service documentaire indisponible'}</Typography>
      <Typography variant="body2">{health.available ? 'La connexion fonctionne. L’extraction et l’OCR restent à vérifier en relançant le fichier.' : health.issue?.message}</Typography>
      {!health.available && health.issue && <Typography variant="body2">{health.issue.action}</Typography>}
      <Typography variant="caption">Vérification à {new Date(health.checkedAt).toLocaleTimeString('fr-FR')}</Typography>
    </Box>}
    {checkError && <Typography role="alert" variant="body2" sx={{ mt: 0.75 }}>{checkError}</Typography>}
    <Box component="details" sx={{ mt: 0.75 }}>
      <Box component="summary" sx={{ cursor: 'pointer', fontSize: '0.75rem' }}>Informations techniques</Box>
      <Typography variant="caption" component="div">Code : {issue.code}</Typography>
      {analysis.issue?.category === 'service' && analysis.issue.diagnostic?.networkCode && <Typography variant="caption" component="div">Réseau : {analysis.issue.diagnostic.networkCode}</Typography>}
      {analysis.issue?.diagnostic?.httpStatus && <Typography variant="caption" component="div">HTTP : {analysis.issue.diagnostic.httpStatus}</Typography>}
      {!health?.available && health?.issue && <Typography variant="caption" component="div">Vérification : {health.issue.code}{health.issue.diagnostic?.networkCode ? ` (${health.issue.diagnostic.networkCode})` : ''}{health.issue.diagnostic?.httpStatus ? ` (HTTP ${health.issue.diagnostic.httpStatus})` : ''}</Typography>}
    </Box>
  </Alert>;
}
