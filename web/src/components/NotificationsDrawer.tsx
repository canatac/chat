import CloseIcon from '@mui/icons-material/Close';
import NotificationsNoneRoundedIcon from '@mui/icons-material/NotificationsNoneRounded';
import { Alert, Box, Button, CircularProgress, Drawer, IconButton, List, ListItem, ListItemButton, Typography } from '@mui/material';
import { mentionLabel } from '../systemNotifications';
import { chatColors } from '../theme';
import type { MentionNotification } from '../types';
import type useMentionNotifications from '../useMentionNotifications';

const time = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

interface Props {
  open: boolean;
  onClose: () => void;
  feed: ReturnType<typeof useMentionNotifications>;
  opening: number | null;
  openError: string | null;
  onOpenMessage: (item: MentionNotification) => void;
}

export default function NotificationsDrawer({ open, onClose, feed, opening, openError, onOpenMessage }: Props) {
  const { page, loading, error, read, load, systemSupported, systemEnabled, systemPending, systemError, toggleSystem } = feed;
  const latestId = page.notifications[0]?.id;
  const actionStyle = { textTransform: 'none', fontWeight: 700, minHeight: 42 } as const;

  return (
    <Drawer anchor="right" open={open} onClose={onClose} slotProps={{ paper: {
      role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'chat-notifications-title',
      sx: { width: 'min(100%, 420px)', bgcolor: chatColors.background, color: chatColors.ink },
    } }}>
      <Box component="header" sx={{ px: 2, py: 1.3, display: 'flex', alignItems: 'center', gap: 1.15, borderBottom: '1px solid ' + chatColors.border, bgcolor: chatColors.surface }}>
        <Box sx={{ width: 40, height: 40, display: 'grid', placeItems: 'center', borderRadius: '10px', bgcolor: chatColors.accentSoft, color: chatColors.accent }}>
          <NotificationsNoneRoundedIcon />
        </Box>
        <Typography component="h2" id="chat-notifications-title" variant="h6" sx={{ flex: 1, minWidth: 0, fontWeight: 750 }}>Notifications</Typography>
        <IconButton aria-label="Fermer les notifications" onClick={onClose} sx={{ width: 42, height: 42, color: chatColors.muted }}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box sx={{ minHeight: 45, px: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1, borderBottom: '1px solid ' + chatColors.border }}>
        <Typography variant="caption" sx={{ color: chatColors.muted, fontWeight: 650 }}>{page.unread} non lue{page.unread === 1 ? '' : 's'}</Typography>
        <Button size="small" disabled={!latestId || !page.unread || loading} onClick={() => { if (latestId) void read({ through: latestId }); }} sx={actionStyle}>
          Tout marquer comme lu
        </Button>
      </Box>
      <Box sx={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: 1, minHeight: 0, px: 1.25, pt: 0.75 }}>
        {(error || openError) && (
          <Alert severity="error" sx={{ mx: 0.5, mb: 1 }} action={error && <Button color="inherit" size="small" onClick={() => void load()}>Réessayer</Button>}>
            {openError ?? error}
          </Alert>
        )}
        {!page.notifications.length && (
          <Box sx={{ py: 4, textAlign: 'center', color: chatColors.muted }}>
            {loading ? <CircularProgress aria-label="Chargement des notifications" size={24} /> : <Typography variant="body2">Aucune notification.</Typography>}
          </Box>
        )}
        <List disablePadding aria-label="Historique des notifications">
          {page.notifications.map((item) => (
            <ListItem disablePadding key={item.id} sx={{ mb: 0.6 }}>
              <ListItemButton component="button" onClick={() => onOpenMessage(item)} disabled={opening !== null}
                sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.9, width: '100%', minWidth: 0, textAlign: 'left', borderRadius: '10px', px: 1.2, py: 1.1, border: '1px solid ' + chatColors.border, bgcolor: item.readAt ? chatColors.surface : chatColors.accentSoft }}>
                <Box aria-hidden="true" sx={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, mt: 0.85, bgcolor: item.readAt ? 'transparent' : chatColors.accent }} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: item.readAt ? 600 : 750, overflowWrap: 'anywhere' }}>{mentionLabel(item)}</Typography>
                  <Typography variant="body2" sx={{ color: chatColors.ink, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere', my: 0.25 }}>
                    {item.preview}
                  </Typography>
                  <Typography component="time" dateTime={item.createdAt} variant="caption" sx={{ color: chatColors.muted }}>{time.format(new Date(item.createdAt))}</Typography>
                </Box>
                {opening === item.id && <CircularProgress size={16} aria-label="Ouverture du message" />}
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        {page.nextBefore !== null && (
          <Button onClick={() => void load(page.nextBefore ?? undefined)} disabled={loading} sx={{ ...actionStyle, mb: 1 }}>
            Notifications précédentes
          </Button>
        )}
      </Box>
      {systemSupported && (
        <Box sx={{ px: 1.75, pt: 0.7, pb: 'max(8px, env(safe-area-inset-bottom))', borderTop: '1px solid ' + chatColors.border, bgcolor: chatColors.surface }}>
          {systemError && <Alert severity="info" sx={{ mt: 0.6 }}>{systemError}</Alert>}
          <Button size="small" disabled={systemPending} onClick={() => void toggleSystem()} sx={actionStyle}>
            {systemEnabled ? 'Désactiver les alertes système' : 'Activer les alertes système'}
          </Button>
        </Box>
      )}
    </Drawer>
  );
}
