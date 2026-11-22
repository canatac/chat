import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { SecurityPolicy, SecurityReview } from '../types';
import type useSecurity from '../useSecurity';

interface Props {
  security: ReturnType<typeof useSecurity>;
  settingsOpen: boolean;
  onClose: () => void;
}

const sourceLabels: Record<SecurityReview['sources'][number]['kind'], string> = {
  question: 'Question actuelle', history: 'Historique de la conversation', documents: 'Documents utilisés',
  agenda: 'Contexte de l’agenda', instructions: 'Instructions de l’assistant', context: 'Autre contexte transmis',
};

const dialogPaper = {
  m: { xs: 2, sm: 4 }, width: { xs: 'calc(100% - 32px)', sm: 'calc(100% - 64px)' },
  maxHeight: { xs: 'calc(100% - 32px)', sm: 'calc(100% - 64px)' },
};

export default function SecurityControls({ security, settingsOpen, onClose }: Props) {
  const { state, review, busy, error } = security;
  const [draft, setDraft] = useState<SecurityPolicy>();
  const [remember, setRemember] = useState(false);
  const [maskingOpen, setMaskingOpen] = useState(false);
  useEffect(() => { if (settingsOpen) setDraft(state?.policy); }, [settingsOpen, state?.policy]);
  useEffect(() => setRemember(false), [review?.id]);

  return (
    <>
      <Box role="status" aria-label="Protection MaelGard" sx={{ px: { xs: 1.5, sm: 3 }, py: 0.6, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ flex: 1, minWidth: 180 }} color={state?.health.available ? 'success.main' : 'warning.main'}>
          {!state ? 'Vérification du service local MaelGard…'
            : state.health.available ? 'Protection locale MaelGard active'
              : 'MaelGard indisponible · Envoi à l’IA bloqué'}
        </Typography>
        {!state?.health.available && <Button size="small" disabled={busy} onClick={() => void security.check()}>Vérifier</Button>}
        {Boolean(state?.remembered) && <Button size="small" onClick={() => setMaskingOpen(true)}>Mes masquages ({state?.remembered})</Button>}
        {error && !settingsOpen && !review && <Typography variant="caption" color="error">{error}</Typography>}
      </Box>
      {security.notice && <Alert severity="success" onClose={security.dismissNotice} sx={{ mx: { xs: 1.5, sm: 3 }, mb: 0.5 }}>{security.notice}</Alert>}
      <Dialog open={settingsOpen} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="security-policy-title" slotProps={{ paper: { sx: dialogPaper } }}>
        <DialogTitle id="security-policy-title">Politique de sécurité MaelGard</DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
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
              <Typography variant="body2">Avec le choix utilisateur, chacun peut mémoriser le masquage des mêmes données pour ses prochaines demandes dans ce salon. Une modification de cette politique efface les masquages mémorisés du salon.</Typography>
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
      <Dialog open={maskingOpen} onClose={busy ? undefined : () => setMaskingOpen(false)} fullWidth maxWidth="sm" aria-labelledby="security-masking-title" slotProps={{ paper: { sx: dialogPaper } }}>
        <DialogTitle id="security-masking-title">Mes masquages mémorisés</DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
          <Stack spacing={1.5}>
            {error && <Alert severity="error">{error}</Alert>}
            <Typography>{state?.remembered ?? 0} masquage(s) mémorisé(s) pour tes demandes dans ce salon.</Typography>
            <Typography variant="body2">Les mêmes données détectées sont automatiquement masquées avant l’envoi à l’IA. LinGuard contrôle toujours chaque demande, y compris l’historique et les documents. Les nouvelles données suivent la politique de l’administrateur.</Typography>
            <Typography variant="body2">Tu peux oublier ces choix pour retrouver les confirmations habituelles. Les messages et les documents originaux restent consultables dans le salon.</Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button disabled={busy} onClick={() => setMaskingOpen(false)}>Fermer</Button>
          <Button disabled={busy || !state?.remembered} onClick={async () => { if (await security.forgetMasking()) setMaskingOpen(false); }}>Oublier mes masquages</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(review)} onClose={busy ? undefined : () => void security.decide('cancel')} fullWidth maxWidth="sm" aria-labelledby="security-review-title" slotProps={{ paper: { sx: dialogPaper } }}>
        <DialogTitle id="security-review-title">Données personnelles détectées</DialogTitle>
        <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {review && (
            <Stack spacing={1.5}>
              <Alert severity="info">L’envoi à l’IA attend ta décision. Même si ta question ne contient aucune donnée personnelle, l’historique et les documents peuvent en contenir.</Alert>
              <Typography>{review.count} occurrence{review.count > 1 ? 's' : ''} à masquer avant l’envoi à l’IA.</Typography>
              <Box component="ul" aria-label="Origine des détections" sx={{ m: 0, pl: 2.5 }}>
                {review.sources.map(({ kind, count }) => <Typography component="li" variant="body2" key={kind}>{sourceLabels[kind]} : {count} occurrence{count > 1 ? 's' : ''}</Typography>)}
              </Box>
              <Typography variant="body2">Types détectés — {review.types.join(', ')}</Typography>
              {review.rememberedCount > 0 && <Typography variant="body2">{review.rememberedCount} autre(s) occurrence(s) sont déjà couvertes par tes masquages mémorisés.</Typography>}
              <Typography variant="body2">Le bouton ci-dessous masque ces données dans la copie envoyée à l’IA. Les messages et documents originaux restent consultables dans le salon.</Typography>
              <FormControlLabel sx={{ alignItems: 'flex-start', mr: 0 }} control={<Checkbox disabled={busy} checked={remember} onChange={(event) => setRemember(event.target.checked)} />} label="Mémoriser ce masquage pour mes prochaines demandes dans ce salon" />
              {remember && <Typography variant="body2">Ces mêmes données seront masquées automatiquement lorsqu’elles seront détectées à nouveau. Les nouvelles données demanderont une nouvelle décision. Tu pourras oublier ce choix dans « Mes masquages ».</Typography>}
              <Typography variant="caption" color="text.secondary">Sans décision avant {new Date(review.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}, l’envoi sera annulé. Tu pourras relancer ta demande.</Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button disabled={busy} onClick={() => void security.decide('cancel')}>Annuler l’envoi</Button>
          <Button variant="contained" disabled={busy} onClick={() => void security.decide('anonymize', remember)}>{remember ? 'Mémoriser et envoyer' : 'Masquer et envoyer'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
