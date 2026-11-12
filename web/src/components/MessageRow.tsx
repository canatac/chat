import AttachFileIcon from '@mui/icons-material/AttachFile';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Avatar, Box, Chip, Paper, Typography } from '@mui/material';
import { api } from '../api';
import type { Message, MessageFile } from '../types';

interface Props {
  message: Message;
  own: boolean;
}

function FileChip({ file }: { file: MessageFile }) {
  const download = async () => {
    try {
      const blob = await api.downloadFile(file.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };
  return (
    <Chip
      size="small"
      icon={<AttachFileIcon />}
      label={file.name}
      onClick={() => void download()}
      sx={{ maxWidth: '100%' }}
    />
  );
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
            {message.files && message.files.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                {message.files.map((f) => (
                  <FileChip key={f.id} file={f} />
                ))}
              </Box>
            )}
          </Paper>
        </Box>
      </Box>
    </Box>
  );
}
