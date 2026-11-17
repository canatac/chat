import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Button, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';

export default function InvitationLink({ href }: { href: string }) {
  const [copyStatus, setCopyStatus] = useState('');

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus('Lien copié.');
    } catch {
      setCopyStatus('Sélectionne le lien pour le copier.');
    }
  }

  return (
    <Stack gap={0.75}>
      <Typography variant="body2">Transmets ce lien à l’invité. Il est à usage unique et expire au bout de 7 jours.</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1}>
        <TextField fullWidth label="Lien d’invitation" size="small" value={href}
          onFocus={(event) => event.target.select()} slotProps={{ input: { readOnly: true } }} />
        <Button startIcon={<ContentCopyOutlinedIcon />} onClick={() => void copyLink()} sx={{ minHeight: 44 }}>Copier</Button>
      </Stack>
      {copyStatus && <Typography role="status" variant="caption">{copyStatus}</Typography>}
    </Stack>
  );
}
