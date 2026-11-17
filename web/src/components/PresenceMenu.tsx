import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import { Avatar, Box, Button, List, ListItem, ListItemAvatar, ListItemText, Popover, TextField, Tooltip, Typography, createFilterOptions } from '@mui/material';
import { useState } from 'react';
import { chatColors } from '../theme';
import type { User } from '../types';

interface Props {
  users: User[];
  onlineIds: number[];
  onManage?: () => void;
}

const filterContacts = createFilterOptions<User>();

export default function PresenceMenu({ users, onlineIds, onManage }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const online = new Set(onlineIds);
  const membersOnline = users.filter((user) => online.has(user.id)).length;
  const orderedUsers = [...filterContacts(users, { inputValue: query, getOptionLabel: (user) => user.name })].sort((left, right) =>
    Number(online.has(right.id)) - Number(online.has(left.id)) || left.name.localeCompare(right.name, 'fr'),
  );

  return (
    <>
      <Tooltip title="Membres">
        <Button
          aria-label="Membres"
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          aria-controls={anchor ? 'chat-members-popover' : undefined}
          onClick={(event) => { setQuery(''); setAnchor(event.currentTarget); }}
          sx={{
            minWidth: { xs: 36, sm: 46 }, minHeight: 40, px: { xs: 0, md: 1.25 }, gap: 0.85, borderRadius: '10px',
            color: chatColors.ink, fontWeight: 650, textTransform: 'none',
            '&:hover': { bgcolor: chatColors.accentSoft, color: chatColors.accent },
          }}
        >
          <GroupOutlinedIcon fontSize="small" />
          <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>{membersOnline} en ligne</Box>
        </Button>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            id: 'chat-members-popover',
            role: 'dialog',
            'aria-labelledby': 'chat-members-title',
            sx: { width: 'min(360px, calc(100vw - 32px))', mt: 1, borderRadius: '14px' },
          },
        }}
      >
        <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid ' + chatColors.border }}>
          <Typography id="chat-members-title" component="h2" variant="subtitle1" sx={{ fontWeight: 750 }}>Membres</Typography>
          <Typography variant="body2" sx={{ color: chatColors.muted }}>{membersOnline} en ligne sur {users.length}</Typography>
          <TextField label="Rechercher un contact" value={query} onChange={(event) => setQuery(event.target.value)}
            size="small" fullWidth sx={{ mt: 1 }} />
        </Box>
        <List dense sx={{ py: 0.5, maxHeight: 'min(55dvh, 390px)', overflowY: 'auto' }}>
          {orderedUsers.map((user) => {
            const isOnline = online.has(user.id);
            return (
              <ListItem key={user.id} sx={{ gap: 1 }}>
                <ListItemAvatar sx={{ minWidth: 35 }}>
                  <Avatar aria-hidden="true" src={user.avatar ?? undefined} sx={{ width: 30, height: 30, bgcolor: chatColors.accentSoft, color: chatColors.accent, fontSize: '0.83rem', fontWeight: 700 }}>
                    {user.name.slice(0, 1).toUpperCase()}
                  </Avatar>
                </ListItemAvatar>
                <ListItemText primary={user.name} sx={{ overflowWrap: 'anywhere' }} />
                <Typography component="span" variant="caption" sx={{ flexShrink: 0, color: isOnline ? chatColors.accent : chatColors.muted }}>
                  {isOnline ? 'En ligne' : 'Hors ligne'}
                </Typography>
              </ListItem>
            );
          })}
          {orderedUsers.length === 0 && <ListItem><ListItemText primary="Aucun contact trouvé" /></ListItem>}
        </List>
        {onManage && (
          <Box sx={{ p: 1.25, borderTop: '1px solid ' + chatColors.border }}>
            <Button onClick={() => { setAnchor(null); onManage(); }} fullWidth sx={{ minHeight: 44 }}>Gérer les contacts</Button>
          </Box>
        )}
      </Popover>
    </>
  );
}
