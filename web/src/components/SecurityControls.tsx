import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SecurityPolicy } from '../types';
import type useSecurity from '../useSecurity';

interface Props {
  security: ReturnType<typeof useSecurity>;
  settingsOpen: boolean;
  onClose: () => void;
}

export default function SecurityControls({ security, settingsOpen, onClose }: Props) {
  const { state, review, busy, error } = security;
  const [draft, setDraft] = useState<SecurityPolicy>();
  useEffect(() => { if (settingsOpen) setDraft(state?.policy); }, [settingsOpen, state?.policy]);

  return (
    <>
      <Box role="status" aria-label="Protection MaelGard" sx={{ px: { xs: 1.5, sm: 3 }, py: 0.6, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ flex: 1, minWidth: 180 }} color={state?.health.available ? 'success.main' : 'warning.main'}>
          {!state ? 'Vérification du service local MaelGard…'
            : state.health.available ? 'Protection locale MaelGard active'
              : 'MaelGard indisponible · Envoi à l’IA bloqué'}
        </Typography>
        {!state?.health.available && <Button size="small" disabled={busy} onClick={() => void security.check()}>Vérifier</Button>}
        {error && !settingsOpen && !review && <Typography variant="caption" color="error">{error}</Typography>}
      </Box>
      <Dialog open={settingsOpen} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
        <DialogTitle>Politique de sécurité MaelGard</DialogTitle>
        <DialogContent dividers>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {draft && (
            <Stack spacing={2}>
              <TextField select fullWidth label="Si des données personnelles sont détectées" value={draft.detection}
                onChange={(event) => setDraft({ ...draft, detection: event.target.value as SecurityPolicy['detection'] })}>
                <MenuItem value="block">Bloquer l’envoi</MenuItem>
                <MenuItem value="anonymize">Masquer automatiquement et envoyer</MenuItem>
                <MenuItem value="ask">Laisser l’utilisateur masquer ou annuler</MenuItem>
              </TextField>
              <TextField select fullWidth label="Si un modèle d’analyse signale une erreur" value={draft.modelErrors}
                onChange={(event) => setDraft({ ...draft, modelErrors: event.target.value as SecurityPolicy['modelErrors'] })}>
                <MenuItem value="fail-closed">Bloquer l’envoi</MenuItem>
                <MenuItem value="fail-open">Continuer avec les détections disponibles</MenuItem>
              </TextField>
              {draft.modelErrors === 'fail-open' && <Alert severity="warning">L’analyse peut être incomplète. Les détections disponibles suivent la politique choisie ci-dessus.</Alert>}
              <Typography variant="body2">Le contrôle porte sur tous les textes transmis à l’IA, avec l’historique et les documents utilisés. Un service inaccessible ou une réponse invalide bloque l’envoi.</Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button onClick={onClose} disabled={busy}>Fermer</Button>
          <Button variant="contained" disabled={busy || !draft} onClick={async () => {
            if (draft && await security.save(draft)) onClose();
          }}>Enregistrer la politique</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(review)} onClose={busy ? undefined : () => void security.decide('cancel')} fullWidth maxWidth="sm">
        <DialogTitle>Données personnelles détectées</DialogTitle>
        <DialogContent dividers>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {review && (
            <Stack spacing={1.5}>
              <Typography>{review.count} détection(s) dans les textes préparés pour l’IA.</Typography>
              <Typography variant="body2">Types détectés — {review.types.join(', ')}</Typography>
              <Typography variant="body2">Score maximal brut — {review.maxScore}</Typography>
              <Typography variant="body2">Tu peux masquer les extraits détectés avant l’envoi ou annuler cette demande. La décision expire après deux minutes.</Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button disabled={busy} onClick={() => void security.decide('cancel')}>Annuler l’envoi</Button>
          <Button variant="contained" disabled={busy} onClick={() => void security.decide('anonymize')}>Masquer et envoyer</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
