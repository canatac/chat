import { Avatar, AvatarGroup, Badge, Box, Chip, List, ListItem, ListItemAvatar, ListItemText, ListSubheader, Popover, Tooltip } from '@mui/material';
import { useState } from 'react';
import type { User } from '../types';

interface Props {
  users: User[];
  onlineIds: number[];
}

export default function PresenceMenu({ users, onlineIds }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const online = users.filter((u) => onlineIds.includes(u.id));

  return (
    <>
      <Tooltip title="Membres de la chatroom (cliquez pour le détail)">
        <Box
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ cursor: 'pointer', mr: 1, display: 'flex', alignItems: 'center' }}
        >
          <AvatarGroup
            max={5}
            sx={{
              '& .MuiAvatar-root': {
                width: 30,
                height: 30,
                fontSize: 14,
                bgcolor: 'rgba(255,255,255,0.25)',
                color: '#fff',
                borderColor: 'rgba(255,255,255,0.6)',
              },
            }}
          >
            {users.map((u) => (
              <Badge
                key={u.id}
                overlap="circular"
                variant="dot"
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                sx={{
                  '& .MuiBadge-badge': {
                    border: '2px solid #128c7e',
                    backgroundColor: onlineIds.includes(u.id) ? '#4caf50' : '#9e9e9e',
                  },
                }}
              >
                <Avatar>{u.name.slice(0, 1).toUpperCase()}</Avatar>
              </Badge>
            ))}
          </AvatarGroup>
        </Box>
      </Tooltip>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <List dense sx={{ minWidth: 260 }}>
          <ListSubheader>
            Membres — {online.length} en ligne / {users.length}
          </ListSubheader>
          {users.map((u) => {
            const isOnline = onlineIds.includes(u.id);
            return (
              <ListItem
                key={u.id}
                secondaryAction={
                  <Chip
                    size="small"
                    label={isOnline ? 'en ligne' : 'hors ligne'}
                    sx={{
                      bgcolor: isOnline ? '#dcf8c6' : '#eeeeee',
                      color: isOnline ? '#075e54' : '#666666',
                    }}
                  />
                }
              >
                <ListItemAvatar>
                  <Badge
                    overlap="circular"
                    variant="dot"
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                    sx={{
                      '& .MuiBadge-badge': {
                        backgroundColor: isOnline ? '#4caf50' : '#9e9e9e',
                      },
                    }}
                  >
                    <Avatar>{u.name.slice(0, 1).toUpperCase()}</Avatar>
                  </Badge>
                </ListItemAvatar>
                <ListItemText primary={u.name} />
              </ListItem>
            );
          })}
          {users.length === 0 && (
            <ListItem>
              <ListItemText primary="Aucun membre" />
            </ListItem>
          )}
        </List>
      </Popover>
    </>
  );
}
