import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Avatar, Box, Paper, Typography } from '@mui/material';
import type { Message } from '../types';

interface Props {
  message: Message;
  own: boolean;
}

export default function MessageRow({ message, own }: Props) {
  const time = new Date(message.createdAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Box sx={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start' }}>
      <Box sx={{ display: 'flex', flexDirection: own ? 'row-reverse' : 'row', gap: 1, maxWidth: '75%' }}>
        {message.user.isBot ? (
          <Avatar sx={{ bgcolor: 'secondary.main' }}>
            <SmartToyIcon fontSize="small" />
          </Avatar>
        ) : (
          <Avatar>{message.user.name.slice(0, 1).toUpperCase()}</Avatar>
        )}
        <Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', textAlign: own ? 'right' : 'left' }}
          >
            {message.user.isBot ? 'Assistant' : message.user.name} · {time}
          </Typography>
          <Paper
            elevation={1}
            sx={{
              px: 1.5,
              py: 1,
              borderRadius: 2,
              bgcolor: own ? '#dcf8c6' : message.user.isBot ? '#fff8e1' : '#ffffff',
              borderTopRightRadius: own ? 4 : 12,
              borderTopLeftRadius: own ? 12 : 4,
            }}
          >
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {message.content}
            </Typography>
          </Paper>
        </Box>
      </Box>
    </Box>
  );
}
