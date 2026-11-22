import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress } from '@mui/material';
import { useEffect, useState } from 'react';
import { api, saveBlob } from '../api';
import type { MeetingArtifact } from '../types';
import MarkdownContent from './MarkdownContent';

export default function MeetingDocumentDialog({ file, onClose }: { file: MeetingArtifact; onClose: () => void }) {
  const [document, setDocument] = useState<{ blob: Blob; text: string }>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    void api.downloadFile(file.id, request.signal).then(async (blob) => {
      const text = await blob.text();
      if (!request.signal.aborted) setDocument({ blob, text });
    }).catch(() => { if (!request.signal.aborted) setError(true); });
    return () => request.abort();
  }, [file.id]);

  const title = file.kind === 'report' ? 'Compte rendu' : file.kind === 'summary' ? 'Résumé' : 'Transcription';

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="meeting-document-title">
      <DialogTitle id="meeting-document-title">{title}</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
        {error && <Alert severity="error">Impossible d’ouvrir le document. Il a peut-être été supprimé.</Alert>}
        {!error && !document && <LinearProgress aria-label="Chargement du document" />}
        {document && (file.kind === 'report' || file.kind === 'summary' || file.mime === 'text/markdown' ? (
          <MarkdownContent content={document.text || 'Ce document est vide.'} />
        ) : (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 }}>
            {document.text || 'Ce document est vide.'}
          </Box>
        ))}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={!document} startIcon={<DownloadOutlinedIcon />} onClick={() => { if (document) saveBlob(document.blob, file.name); }}>
          Télécharger
        </Button>
        <Button onClick={onClose}>Fermer</Button>
      </DialogActions>
    </Dialog>
  );
}
