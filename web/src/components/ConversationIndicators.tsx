import { keyframes } from '@emotion/react';
import { Box, Typography } from '@mui/material';
import { chatColors } from '../theme';

const bounce = keyframes`
  0%, 70%, 100% { transform: translateY(0); opacity: 0.6; }
  35% { transform: translateY(-3px); opacity: 1; }
`;

interface Props {
  typing: string[];
  assistantResponding: boolean;
  agendaPending: boolean;
}

export default function ConversationIndicators({ typing, assistantResponding, agendaPending }: Props) {
  const labels: string[] = [];
  if (typing.length === 1) labels.push(`${typing[0]} écrit`);
  else if (typing.length === 2) labels.push(`${typing[0]} et ${typing[1]} écrivent`);
  else if (typing.length > 2) labels.push(`${typing.length} personnes écrivent`);
  if (assistantResponding) labels.push('L’assistant prépare une réponse');
  if (agendaPending) labels.push('L’assistant consulte l’agenda');

  return (
    <Box role="status" aria-label="Activité de la conversation" sx={{ display: 'flex', flexWrap: 'wrap', gap: labels.length ? 0.75 : 0, mb: labels.length ? 0.7 : 0 }}>
      {labels.map((label) => (
        <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, color: chatColors.accent }}>
          <Box component="span" aria-hidden="true" sx={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
            {[0, 1, 2].map((dot) => (
              <Box key={dot} component="span" sx={{
                width: 4, height: 4, borderRadius: '50%', bgcolor: 'currentColor',
                animation: `${bounce} 1.25s ${dot * 0.14}s infinite ease-in-out`,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }} />
            ))}
          </Box>
          <Typography component="span" variant="caption" sx={{ color: chatColors.ink, overflowWrap: 'anywhere' }}>
            {label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
