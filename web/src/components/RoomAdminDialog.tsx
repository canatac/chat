import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, IconButton, MenuItem, Stack, TextField, Typography, createFilterOptions, useMediaQuery, useTheme,
} from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { api, invitationUrl, openRoom } from '../api';
import { chatColors } from '../theme';
import type { Role, Room, RoomInvitation, RoomMember, User } from '../types';
import InvitationLink from './InvitationLink';

const roles: Record<Role, string> = { superadmin: 'Superadmin', admin: 'Admin', member: 'Membre' };
const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
const wrapText = { overflowWrap: 'anywhere' };
const row = { p: 1.4, border: '1px solid ' + chatColors.border, borderRadius: 2 };
const sentenceButton = { textTransform: 'none' };
const filterContacts = createFilterOptions<RoomMember>({ stringify: ({ name, email }) => `${name} ${email ?? ''}` });

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue';
}

async function readAvatar(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('Choisissez une image JPEG, PNG, WebP, GIF ou AVIF de 8 Mo maximum.');
  }
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('La conversion de l’image est indisponible.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 96, 96);
    return canvas.toDataURL('image/jpeg', 0.78);
  } finally {
    URL.revokeObjectURL(source);
  }
}

interface MemberEditorProps {
  member: RoomMember;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: { alias: string; email?: string; avatar: string | null }) => void;
}

function MemberEditor({ member, busy, error, onClose, onSave }: MemberEditorProps) {
  const [alias, setAlias] = useState(member.name);
  const [email, setEmail] = useState(member.email ?? '');
  const [avatar, setAvatar] = useState(member.avatar ?? null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  async function selectAvatar(file: File) {
    setImageError(null);
    setConverting(true);
    try {
      setAvatar(await readAvatar(file));
    } catch (err) {
      setImageError(messageFor(err));
    } finally {
      setConverting(false);
    }
  }

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="edit-room-member-title">
      <Box component="form" onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSave({ alias: alias.trim(), ...(email.trim() ? { email: email.trim() } : {}), avatar });
      }}>
        <DialogTitle id="edit-room-member-title">Modifier le profil</DialogTitle>
        <DialogContent>
          <Stack gap={1.6} sx={{ pt: 0.75 }}>
            <Stack direction="row" alignItems="center" gap={1.25} flexWrap="wrap">
              <Avatar src={avatar ?? undefined} sx={{ bgcolor: chatColors.accentSoft, color: chatColors.accent }}>
                {alias.slice(0, 1).toUpperCase()}
              </Avatar>
              <Button component="label" disabled={converting || busy} sx={sentenceButton}>
                Choisir un avatar
                <input hidden type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void selectAvatar(file);
                }} />
              </Button>
              {avatar && <Button disabled={converting || busy} onClick={() => setAvatar(null)} sx={sentenceButton}>Retirer l’avatar</Button>}
            </Stack>
            <TextField size="small" required label="Alias" value={alias} onChange={(event) => setAlias(event.target.value)} slotProps={{ htmlInput: { minLength: 2, maxLength: 40 } }} />
            <TextField size="small" type="email" required={Boolean(member.email)} label="Adresse e-mail" value={email} onChange={(event) => setEmail(event.target.value)} />
            {imageError && <Alert severity="error">{imageError}</Alert>}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy} sx={sentenceButton}>Annuler</Button>
          <Button type="submit" variant="contained" disabled={busy || converting} sx={sentenceButton}>Enregistrer</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

interface Props {
  user: User;
  rooms: Room[];
  currentRoomId: number | null;
  onClose: () => void;
  onRoomChange: (room: Room) => void;
  onRoomsLoaded: (rooms: Room[]) => void;
  onMemberChange: (member: RoomMember) => void;
}

export default function RoomAdminDialog({ user, rooms, currentRoomId, onClose, onRoomChange, onRoomsLoaded, onMemberChange }: Props) {
  const isSuperadmin = user.role === 'superadmin';
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const [selected, setSelected] = useState<number | null>(currentRoomId ?? rooms[0]?.id ?? null);
  const room = rooms.find((item) => item.id === selected);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [contactQuery, setContactQuery] = useState('');
  const [invitations, setInvitations] = useState<RoomInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nameForm, setNameForm] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoomInvitation['role']>('member');
  const [shareLink, setShareLink] = useState<{ id: number; expiresAt: number; href: string } | null>(null);
  const [editing, setEditing] = useState<RoomMember | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; detail: string; action: () => Promise<void> } | null>(null);
  const visibleMembers = filterContacts(members, { inputValue: contactQuery, getOptionLabel: (member) => member.name });

  useEffect(() => {
    if (selected === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setMembers([]);
    setInvitations([]);
    Promise.all([
      api.rooms.members(selected, controller.signal),
      api.rooms.invitations(selected, controller.signal),
      isSuperadmin ? api.rooms.list(controller.signal) : null,
    ])
      .then(([membersResult, invitesResult, directory]) => {
        if (controller.signal.aborted) return;
        if (directory) onRoomsLoaded(directory.rooms);
        setMembers(membersResult.members);
        setInvitations(invitesResult.invitations);
        setShareLink((previous) => invitesResult.invitations.some((item) =>
          item.id === previous?.id && item.expiresAt === previous.expiresAt) ? previous : null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(messageFor(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected, refresh, isSuperadmin, onRoomsLoaded]);

  function selectRoom(roomId: number) {
    setSelected(roomId);
    setShareLink(null);
    setContactQuery('');
    setEmail('');
    setRole('member');
    setNameForm(null);
  }

  async function perform(action: () => Promise<void>, inDialog = false) {
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      (inDialog ? setActionError : setError)(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  function submitName(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      if (nameForm === 'create') {
        const result = await api.rooms.create(name.trim());
        onRoomChange(result.room);
        selectRoom(result.room.id);
      } else if (room) {
        const result = await api.rooms.rename(room.id, name.trim());
        onRoomChange(result.room);
      }
      setNameForm(null);
    });
  }

  function issueInvitation(address: string, inviteRole: RoomInvitation['role']) {
    if (!room) return;
    void perform(async () => {
      const result = await api.rooms.invite(room.id, address, inviteRole);
      setShareLink({ id: result.invitation.id, expiresAt: result.invitation.expiresAt, href: invitationUrl(result.token) });
      setInvitations((previous) => [result.invitation, ...previous.filter((item) => item.email !== result.invitation.email)]);
      setEmail('');
    });
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    issueInvitation(email.trim(), role);
  }

  function canEdit(member: RoomMember): boolean {
    return member.id === user.id || member.role === 'member' || (member.role === 'admin' && isSuperadmin);
  }

  function archiveRoom() {
    if (!room) return;
    const roomId = room.id;
    async function apply(archived: boolean) {
      const result = await api.rooms.archive(roomId, archived);
      onRoomChange(result.room);
      if (archived) {
        setInvitations([]);
        setShareLink(null);
      }
    }
    if (room.archivedAt !== null) {
      void perform(() => apply(false));
    } else {
      setActionError(null);
      setConfirm({
        title: 'Archiver ce salon ?',
        detail: 'Les membres seront déconnectés et les invitations en attente seront révoquées. Les messages et les fichiers resteront disponibles après réactivation.',
        action: () => apply(true),
      });
    }
  }

  return (
    <>
      <Dialog open onClose={busy ? undefined : onClose} fullScreen={fullScreen} fullWidth maxWidth="md" aria-labelledby="room-admin-title">
        <DialogTitle id="room-admin-title" sx={{ display: 'flex', alignItems: 'center', gap: 1.3, color: chatColors.ink, pb: 1.5 }}>
          <Box sx={{ display: 'grid', placeItems: 'center', width: 40, height: 40, bgcolor: chatColors.accentSoft, color: chatColors.accent, borderRadius: 2 }}>
            <GroupsOutlinedIcon />
          </Box>
          <Box component="span" sx={{ flex: 1, fontWeight: 750 }}>Administration</Box>
          <IconButton aria-label="Fermer l’administration" onClick={onClose} disabled={busy}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: chatColors.background, pt: 2.25 }}>
          <Stack spacing={2.25}>
            <Stack gap={1.25} sx={{ ...row, bgcolor: chatColors.surface }}>
              {isSuperadmin ? (
                <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} gap={1.25}>
                  <TextField
                    label="Salon à gérer"
                    select
                    size="small"
                    value={selected ?? ''}
                    disabled={busy || !rooms.length}
                    onChange={(event) => selectRoom(Number(event.target.value))}
                    sx={{ flex: 1, minWidth: 0 }}
                  >
                    {!rooms.length && <MenuItem value="">Aucun salon</MenuItem>}
                    {rooms.map((item) => (
                      <MenuItem key={item.id} value={item.id} sx={{ whiteSpace: 'normal', ...wrapText }}>
                        {item.name}{item.archivedAt === null ? '' : ' (archivé)'}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    startIcon={<AddIcon />}
                    variant="outlined"
                    disabled={busy || loading}
                    onClick={() => { setName(''); setNameForm('create'); }}
                    sx={sentenceButton}
                  >
                    Nouveau salon
                  </Button>
                </Stack>
              ) : room && <Typography component="h3" variant="h6" sx={{ fontWeight: 700, ...wrapText }}>{room.name}</Typography>}
              {room && (
                <Stack direction="row" flexWrap="wrap" gap={0.5} alignItems="center">
                  {room.archivedAt !== null && <Chip size="small" label="Archivé" />}
                  {room.archivedAt === null && currentRoomId !== room.id && (
                    <Button disabled={busy} onClick={() => openRoom(room.id)} sx={sentenceButton}>Ouvrir le salon</Button>
                  )}
                  <Button disabled={busy || loading} onClick={() => { setName(room.name); setNameForm('rename'); }} sx={sentenceButton}>Renommer</Button>
                  {isSuperadmin && (
                    <Button disabled={busy || loading} onClick={archiveRoom} color={room.archivedAt === null ? 'error' : 'primary'} sx={sentenceButton}>
                      {room.archivedAt === null ? 'Archiver' : 'Réactiver'}
                    </Button>
                  )}
                </Stack>
              )}
              {nameForm && (
                <Stack component="form" onSubmit={submitName} gap={1} direction={{ xs: 'column', sm: 'row' }}>
                  <TextField autoFocus required label="Nom du salon" value={name} onChange={(event) => setName(event.target.value)} size="small" sx={{ flex: 1 }} slotProps={{ htmlInput: { minLength: 2, maxLength: 80 } }} />
                  <Button variant="contained" type="submit" disabled={busy || loading} sx={sentenceButton}>{nameForm === 'create' ? 'Créer le salon' : 'Enregistrer le nom'}</Button>
                  <Button onClick={() => setNameForm(null)} disabled={busy} sx={sentenceButton}>Annuler</Button>
                </Stack>
              )}
            </Stack>
            {error && <Alert severity="error">{error}</Alert>}
            {loading && <CircularProgress size={25} aria-label="Chargement du salon" />}
            {room && !loading && (
              <>
                {room.archivedAt === null && (
                  <Stack gap={1.4} sx={{ ...row, bgcolor: chatColors.surface }}>
                    <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 750 }}>Inviter dans ce salon</Typography>
                    <Stack component="form" onSubmit={invite} direction={{ xs: 'column', sm: 'row' }} gap={1}>
                      <TextField label="E-mail à inviter" type="email" required size="small" value={email} onChange={(event) => setEmail(event.target.value)} sx={{ flex: 1 }} />
                      {isSuperadmin && (
                        <TextField label="Rôle" select size="small" value={role} onChange={(event) => setRole(event.target.value as RoomInvitation['role'])} sx={{ minWidth: 108 }}>
                          <MenuItem value="member">Membre</MenuItem>
                          <MenuItem value="admin">Admin</MenuItem>
                        </TextField>
                      )}
                      <Button variant="contained" type="submit" disabled={busy} sx={{ ...sentenceButton, bgcolor: chatColors.accent }}>Créer le lien</Button>
                    </Stack>
                    {shareLink && <InvitationLink key={shareLink.href} href={shareLink.href} />}
                    {invitations.length > 0 && (
                      <>
                        <Divider />
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>Invitations en attente</Typography>
                        {invitations.map((item) => (
                          <Stack key={item.id} direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" gap={0.5}>
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2" sx={wrapText}>{item.email}</Typography>
                              <Typography variant="caption" sx={{ color: chatColors.muted }}>Expire le {dateFormat.format(item.expiresAt)} · {roles[item.role]}</Typography>
                            </Box>
                            <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.5} sx={{ flexShrink: 0 }}>
                              {(item.role === 'member' || isSuperadmin) && (
                                <Button aria-label={'Renouveler le lien pour ' + item.email} disabled={busy}
                                  onClick={() => issueInvitation(item.email, item.role)} sx={{ ...sentenceButton, minHeight: 44 }}>
                                  Renouveler le lien
                                </Button>
                              )}
                              <Button aria-label={'Révoquer l’invitation pour ' + item.email}
                                disabled={busy} onClick={() => void perform(async () => {
                                  await api.rooms.revoke(room.id, item.id);
                                  setInvitations((previous) => previous.filter((invite) => invite.id !== item.id));
                                  if (shareLink?.id === item.id) setShareLink(null);
                                })} sx={{ ...sentenceButton, minHeight: 44 }}>
                                Révoquer
                              </Button>
                            </Stack>
                          </Stack>
                        ))}
                      </>
                    )}
                  </Stack>
                )}
                <Stack gap={1} sx={{ ...row, bgcolor: chatColors.surface }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography component="h3" variant="subtitle1" sx={{ fontWeight: 750 }}>Contacts du salon</Typography>
                    <IconButton aria-label="Actualiser les membres" onClick={() => setRefresh((count) => count + 1)} disabled={busy}>
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                  <TextField label="Rechercher par alias ou e-mail" value={contactQuery}
                    onChange={(event) => setContactQuery(event.target.value)} size="small" fullWidth />
                  {visibleMembers.length === 0 && !error && <Typography variant="body2" sx={{ color: chatColors.muted }}>Aucun contact trouvé.</Typography>}
                  {visibleMembers.map((member) => (
                    <Stack key={member.id} direction={{ xs: 'column', sm: 'row' }} gap={1.2} alignItems={{ sm: 'center' }} sx={row}>
                      <Stack direction="row" alignItems="center" gap={1.15} sx={{ minWidth: 0, flex: 1 }}>
                        <Avatar src={member.avatar ?? undefined} sx={{ bgcolor: chatColors.accentSoft, color: chatColors.accent }}>
                          {member.name.slice(0, 1).toUpperCase()}
                        </Avatar>
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" sx={{ fontWeight: 700, ...wrapText }}>{member.name}{member.id === user.id ? ' (vous)' : ''}</Typography>
                          {member.email && <Typography variant="caption" sx={{ color: chatColors.muted, ...wrapText }}>{member.email}</Typography>}
                        </Box>
                        <Chip size="small" variant="outlined" label={roles[member.role]} />
                      </Stack>
                      {canEdit(member) && (
                        <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.5}>
                          <Button
                            size="small"
                            aria-label={'Modifier ' + member.name}
                            disabled={busy}
                            onClick={() => { setActionError(null); setEditing(member); }}
                            sx={{ ...sentenceButton, minHeight: 44 }}
                          >
                            Modifier
                          </Button>
                          {member.id !== user.id && member.role !== 'superadmin' && (
                            <Button
                              size="small"
                              color="error"
                              aria-label={'Retirer ' + member.name}
                              disabled={busy}
                              onClick={() => {
                                setActionError(null);
                                setConfirm({
                                  title: 'Retirer ' + member.name + ' ?',
                                  detail: 'Son accès au salon sera révoqué immédiatement. Ses messages et ses fichiers seront conservés.',
                                  action: async () => {
                                    await api.rooms.removeMember(room.id, member.id);
                                    setMembers((previous) => previous.filter((item) => item.id !== member.id));
                                  },
                                });
                              }}
                              sx={{ ...sentenceButton, minHeight: 44 }}
                            >
                              Retirer
                            </Button>
                          )}
                        </Stack>
                      )}
                    </Stack>
                  ))}
                </Stack>
              </>
            )}
          </Stack>
        </DialogContent>
      </Dialog>
      {editing && room && (
        <MemberEditor
          member={editing}
          busy={busy}
          error={actionError}
          onClose={() => setEditing(null)}
          onSave={(patch) => void perform(async () => {
            const result = await api.rooms.updateMember(room.id, editing.id, patch);
            setMembers((previous) => previous.map((item) => item.id === editing.id ? result.member : item));
            onMemberChange(result.member);
            setEditing(null);
          }, true)}
        />
      )}
      {confirm && (
        <Dialog open onClose={busy ? undefined : () => setConfirm(null)} fullWidth maxWidth="xs" aria-labelledby="confirm-room-admin-title">
          <DialogTitle id="confirm-room-admin-title">{confirm.title}</DialogTitle>
          <DialogContent>
            <Typography variant="body2">{confirm.detail}</Typography>
            {actionError && <Alert severity="error" sx={{ mt: 1 }}>{actionError}</Alert>}
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => setConfirm(null)} sx={sentenceButton}>Annuler</Button>
            <Button disabled={busy} variant="contained" color="error" onClick={() => void perform(async () => {
              await confirm.action();
              setConfirm(null);
            }, true)} sx={sentenceButton}>Confirmer</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
