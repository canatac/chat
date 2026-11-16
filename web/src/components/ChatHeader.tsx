import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import PhoneIcon from '@mui/icons-material/Phone';
import { Avatar, Badge, Box, Button, ButtonBase, Divider, ListItemIcon, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { chatColors } from '../theme';
import type { User } from '../types';
import PresenceMenu from './PresenceMenu';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

interface Props {
  roomName: string;
  user: User;
  users: User[];
  onlineIds: number[];
  connection: ConnectionStatus;
  hasCall: boolean;
  onCall: () => void;
  onDocuments: () => void;
  onAdmin: () => void;
  onStats: () => void;
  onLogout: () => void;
}

const connectionLabel = {
  connecting: 'Connexion…',
  online: 'Connecté',
  offline: 'Hors ligne',
};

const connectionColor = {
  connecting: '#8a5717',
  online: chatColors.accent,
  offline: '#6d8388',
};

const actionStyle = {
  color: chatColors.ink,
  borderRadius: '10px',
  minWidth: { xs: 36, sm: 46 },
  minHeight: 40,
  maxHeight: 42,
  px: { xs: 0, md: 1.4 },
  gap: 0.85,
  fontWeight: 650,
  textTransform: 'none',
  '&:hover': { bgcolor: chatColors.accentSoft, color: chatColors.accent },
};

export default function ChatHeader({
  roomName, user, users, onlineIds, connection, hasCall, onCall, onDocuments, onAdmin, onStats, onLogout,
}: Props) {
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null);
  const callLabel = hasCall ? 'Appel en cours' : "Appel d'équipe";
  const closeAccount = () => setAccountAnchor(null);

  return (
    <Box component="header" sx={{ bgcolor: chatColors.surface, borderBottom: '1px solid ' + chatColors.border, flexShrink: 0 }}>
      <Box
        sx={{
          mx: 'auto',
          maxWidth: 1120,
          px: { xs: 1.8, sm: 3 },
          minHeight: { xs: 62, sm: 72 },
          display: 'flex',
          alignItems: 'center',
          gap: { xs: 0.5, sm: 1.75 },
          '@media (max-width:359px)': { px: 1.25 },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1, gap: { xs: 1, sm: 1.4 } }}>
          <Box
            sx={{
              display: 'grid', placeItems: 'center', width: { xs: 35, sm: 44 }, height: { xs: 35, sm: 44 },
              flexShrink: 0, borderRadius: '12px', bgcolor: chatColors.accentSoft, color: chatColors.accent,
            }}
          >
            <ForumOutlinedIcon sx={{ fontSize: { xs: 19, sm: 23 } }} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography
              component="h1"
              title={roomName}
              noWrap
              sx={{ color: chatColors.ink, fontSize: { xs: '0.96rem', sm: '1.28rem' }, fontWeight: 740, letterSpacing: '-0.025em', lineHeight: 1.22 }}
            >
              {roomName}
            </Typography>
            <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 0.65, minWidth: 0, mt: 0.25 }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: connectionColor[connection], flexShrink: 0 }} />
              <Typography noWrap variant="caption" sx={{ color: chatColors.muted, fontSize: { xs: '0.68rem', sm: '0.75rem' } }}>
                {connectionLabel[connection]}
              </Typography>
            </Box>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.15, sm: 0.6 }, flexShrink: 0 }}>
          <Tooltip title={callLabel}>
            <Button aria-label={callLabel} onClick={onCall} sx={actionStyle}>
              <Badge variant="dot" color="error" invisible={!hasCall}>
                <PhoneIcon fontSize="small" />
              </Badge>
              <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>{hasCall ? 'Appel en cours' : 'Appel'}</Box>
            </Button>
          </Tooltip>
          <Tooltip title="Espace documentaire">
            <Button aria-label="Espace documentaire" onClick={onDocuments} sx={actionStyle}>
              <FolderOpenOutlinedIcon fontSize="small" />
              <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>Documents</Box>
            </Button>
          </Tooltip>
          <PresenceMenu users={users} onlineIds={onlineIds} />
          <Box sx={{ height: 24, borderLeft: '1px solid ' + chatColors.border, mx: { xs: 0.3, sm: 0.75 } }} />
          <Tooltip title="Compte">
            <ButtonBase
              aria-label={'Compte de ' + user.name}
              aria-haspopup="menu"
              aria-expanded={Boolean(accountAnchor)}
              aria-controls={accountAnchor ? 'chat-account-menu' : undefined}
              onClick={(event) => setAccountAnchor(event.currentTarget)}
              sx={{
                p: { xs: 0.3, sm: 0.5 }, borderRadius: '10px', gap: 0.9, maxWidth: 155, minHeight: 40, textAlign: 'left',
                '&:hover': { bgcolor: chatColors.background },
                '&.Mui-focusVisible': { outline: '2px solid ' + chatColors.accent },
              }}
            >
              <Avatar
                aria-hidden="true"
                src={user.avatar ?? undefined}
                sx={{ width: 32, height: 32, bgcolor: chatColors.accentSoft, color: chatColors.accent, fontSize: '0.83rem', fontWeight: 750 }}
              >
                {user.name.slice(0, 1).toUpperCase()}
              </Avatar>
              <Typography noWrap sx={{ display: { xs: 'none', sm: 'block' }, fontSize: '0.86rem', fontWeight: 700, color: chatColors.ink }}>
                {user.name}
              </Typography>
            </ButtonBase>
          </Tooltip>
        </Box>

        <Menu
          id="chat-account-menu"
          open={Boolean(accountAnchor)}
          anchorEl={accountAnchor}
          onClose={closeAccount}
          slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 'calc(100vw - 32px)', mt: 1, borderRadius: '12px' } } }}
        >
          <Typography noWrap sx={{ px: 2, py: 1, fontWeight: 700, color: chatColors.ink }}>{user.name}</Typography>
          <Divider sx={{ mb: 0.5 }} />
          {(user.role === 'admin' || user.role === 'superadmin') && [
            <MenuItem key="admin" onClick={() => { closeAccount(); onAdmin(); }}>
              <ListItemIcon><AdminPanelSettingsOutlinedIcon fontSize="small" /></ListItemIcon>
              Administration
            </MenuItem>,
            <MenuItem key="stats" onClick={() => { closeAccount(); onStats(); }}>
              <ListItemIcon><InsightsOutlinedIcon fontSize="small" /></ListItemIcon>
              Statistiques du salon
            </MenuItem>,
          ]}
          <MenuItem onClick={() => { closeAccount(); onLogout(); }}>
            <ListItemIcon><LogoutOutlinedIcon fontSize="small" /></ListItemIcon>
            Se déconnecter
          </MenuItem>
        </Menu>
      </Box>
    </Box>
  );
}
