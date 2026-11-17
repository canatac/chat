import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import type { MoveConflict, MoveDecision } from '../types';

interface Props {
  conflict: MoveConflict;
  destination: string;
  remaining: number;
  busy: boolean;
  error: string | null;
  onResolve: (decision: MoveDecision) => void;
  onCancel: () => void;
}

const actionStyle = { textTransform: 'none', fontWeight: 700, minHeight: 42 } as const;

export default function MoveConflictDialog({ conflict, destination, remaining, busy, error, onResolve, onCancel }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(conflict.name);
  const { kind, id, replaceToken } = conflict;
  const trimmed = name.trim();
  const sameName = trimmed.normalize('NFC').toLowerCase() === conflict.name.normalize('NFC').toLowerCase();
  const explanation = conflict.reason === 'planned'
    ? `« ${conflict.name} » est déjà attribué à un autre élément du déplacement.`
    : `« ${conflict.name} » est déjà utilisé dans « ${destination} ».`;

  return (
    <Dialog open fullWidth maxWidth="xs" onClose={() => { if (!busy) onCancel(); }} aria-labelledby="doc-conflict-title">
      <Box component="form" onSubmit={(event) => {
        event.preventDefault();
        if (renaming && !busy && trimmed && !sameName) onResolve({ kind, id, action: 'rename', name: trimmed });
      }}>
        <DialogTitle id="doc-conflict-title">Résoudre le doublon</DialogTitle>
        <DialogContent dividers>
          {remaining > 1 && <Typography variant="caption" color="text.secondary">{remaining} doublons à traiter</Typography>}
          <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{explanation}</Typography>
          {conflict.name !== conflict.sourceName && (
            <Typography variant="body2" sx={{ mt: 0.65, overflowWrap: 'anywhere' }}>Nouvelle tentative pour « {conflict.sourceName} ».</Typography>
          )}
          {conflict.changed && <Alert severity="info" sx={{ mt: 1 }}>Le conflit a changé. Choisissez de nouveau l’action à effectuer.</Alert>}
          {conflict.reason === 'selection' && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Le remplacement supprimerait un élément de la sélection. Vous pouvez renommer ou ignorer cet élément.
            </Typography>
          )}
          {replaceToken && !renaming && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {kind === 'folder'
                ? (conflict.existing === 1 ? 'Remplacer supprimera le dossier présent et son contenu.' : `Remplacer supprimera les ${conflict.existing} dossiers présents et leur contenu.`)
                : (conflict.existing === 1 ? 'Remplacer supprimera le fichier déjà présent.' : `Remplacer supprimera les ${conflict.existing} fichiers qui portent ce nom.`)}
            </Typography>
          )}
          {renaming && (
            <TextField autoFocus fullWidth size="small" sx={{ mt: 1.5 }} label="Nouveau nom" value={name} disabled={busy}
              onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)}
              slotProps={{ htmlInput: { maxLength: kind === 'folder' ? 120 : 255 } }} />
          )}
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.75, px: 2, py: 1.1 }} disableSpacing>
          {renaming ? (
            <>
              <Button disabled={busy} onClick={() => setRenaming(false)} sx={actionStyle}>Retour</Button>
              <Button type="submit" variant="contained" disabled={busy || !trimmed || sameName} sx={actionStyle}>Renommer et déplacer</Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onResolve({ kind, id, action: 'skip' })} sx={actionStyle}>Ignorer</Button>
              <Button variant="outlined" disabled={busy} onClick={() => setRenaming(true)} sx={actionStyle}>Renommer</Button>
              {replaceToken && (
                <Button color="error" variant="outlined" disabled={busy} sx={actionStyle}
                  onClick={() => onResolve({ kind, id, action: 'replace', token: replaceToken, name: conflict.name === conflict.sourceName ? undefined : conflict.name })}>
                  Remplacer
                </Button>
              )}
            </>
          )}
          <Box sx={{ width: '100%', display: 'flex', justifyContent: 'flex-end' }}>
            <Button size="small" color="inherit" disabled={busy} onClick={onCancel} sx={actionStyle}>Annuler le déplacement</Button>
          </Box>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
