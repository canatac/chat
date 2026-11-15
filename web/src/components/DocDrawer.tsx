import AudioFileIcon from '@mui/icons-material/AudioFile';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FolderIcon from '@mui/icons-material/Folder';
import HistoryIcon from '@mui/icons-material/History';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import RefreshIcon from '@mui/icons-material/Refresh';
import RenameIcon from '@mui/icons-material/DriveFileRenameOutline';
import SearchIcon from '@mui/icons-material/Search';
import SummarizeIcon from '@mui/icons-material/Summarize';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Avatar,
  Box,
  Breadcrumbs,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { ChatSocket } from '../ws';
import type { FileEvent, FileItem, Folder } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  socket: ChatSocket | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function fileIcon(f: FileItem) {
  if (f.mime.startsWith('audio/')) return <AudioFileIcon />;
  if (f.mime === 'application/pdf') return <PictureAsPdfIcon />;
  return <InsertDriveFileIcon />;
}

const ACTION_LABELS: Record<string, string> = {
  file_created: 'Déposé',
  file_renamed: 'Renommé',
  file_moved: 'Déplacé',
  file_deleted: 'Supprimé',
  file_transcribed: 'Transcrit (STT)',
  file_derived: 'Résumé / CR généré (LLM)',
  folder_created: 'Dossier créé',
  folder_renamed: 'Dossier renommé',
  folder_moved: 'Dossier déplacé',
  folder_deleted: 'Dossier supprimé',
};

type MenuTarget =
  | { kind: 'folder'; item: Folder }
  | { kind: 'file'; item: FileItem }
  | null;

type NameDialog =
  | { mode: 'new-folder' }
  | { mode: 'rename-folder'; folder: Folder }
  | { mode: 'rename-file'; file: FileItem }
  | null;

type MoveDialog =
  | { kind: 'folder'; item: Folder }
  | { kind: 'file'; item: FileItem }
  | null;

type DeleteDialog =
  | { kind: 'folder'; item: Folder; counts: { folders: number; files: number; directFiles: number } | null }
  | { kind: 'file'; item: FileItem }
  | null;

export default function DocDrawer({ open, onClose, socket }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; target: MenuTarget } | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog>(null);
  const [nameValue, setNameValue] = useState('');
  const [moveDialog, setMoveDialog] = useState<MoveDialog>(null);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog>(null);
  const [deleteRecursive, setDeleteRecursive] = useState(false);
  const [detail, setDetail] = useState<{ file: FileItem; folderPath: Folder[]; history: FileEvent[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (q: string, folderId: number | null) => {
    try {
      const [f, r] = await Promise.all([
        api.folders(),
        api.files(q, undefined, 300, q ? undefined : folderId),
      ]);
      setFolders(f.folders);
      setFiles(r.files);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    }
  }, []);

  useEffect(() => {
    if (open) void load(query, currentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentId]);

  useEffect(() => {
    if (!socket) return;
    const handler = (event: { type: string }) => {
      if (event.type === 'docsChanged') void load(query, currentId);
    };
    socket.onMessage(handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  const breadcrumb = useMemo(() => {
    const path: Folder[] = [];
    let cur: number | null = currentId;
    const seen = new Set<number>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      path.unshift(f);
      cur = f.parentId;
    }
    return path;
  }, [folders, currentId]);

  const childFolders = useMemo(
    () => folders.filter((f) => f.parentId === currentId).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [folders, currentId],
  );

  const folderPathOf = useCallback(
    (folderId: number | null): string => {
      if (folderId === null) return 'Racine';
      const parts: string[] = [];
      let cur: number | null = folderId;
      const seen = new Set<number>();
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        const f = folders.find((x) => x.id === cur);
        if (!f) break;
        parts.unshift(f.name);
        cur = f.parentId;
      }
      return parts.join(' / ') || 'Racine';
    },
    [folders],
  );

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      await api.uploadFile(f, '', false, query ? undefined : currentId);
      await load(query, currentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur d'envoi");
    } finally {
      setUploading(false);
    }
  };

  const download = async (f: FileItem) => {
    try {
      const blob = await api.downloadFile(f.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };

  const derive = async (f: FileItem, kind: 'resume' | 'cr') => {
    setError(null);
    try {
      await api.derive(f.id, kind);
      await load(query, currentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de génération');
    }
  };

  const transcribe = async (f: FileItem) => {
    setError(null);
    try {
      await api.transcribe(f.id);
      await load(query, currentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de transcription');
    }
  };

  const openNameDialog = (d: NameDialog) => {
    setMenu(null);
    setNameDialog(d);
    setNameValue(d?.mode === 'rename-folder' ? d.folder.name : d?.mode === 'rename-file' ? d.file.name : '');
  };

  const submitName = async () => {
    if (!nameDialog) return;
    const name = nameValue.trim();
    if (!name) return;
    setError(null);
    try {
      if (nameDialog.mode === 'new-folder') await api.createFolder(name, currentId);
      else if (nameDialog.mode === 'rename-folder') await api.patchFolder(nameDialog.folder.id, { name });
      else if (nameDialog.mode === 'rename-file') await api.patchFile(nameDialog.file.id, { name });
      setNameDialog(null);
      await load(query, currentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    }
  };

  const openMove = (d: MoveDialog) => {
    setMenu(null);
    setMoveDialog(d);
    setMoveTarget(d?.kind === 'folder' ? d.item.parentId : d?.kind === 'file' ? d.item.folderId : null);
  };

  const submitMove = async () => {
    if (!moveDialog) return;
    setError(null);
    try {
      if (moveDialog.kind === 'folder') await api.patchFolder(moveDialog.item.id, { parentId: moveTarget });
      else await api.patchFile(moveDialog.item.id, { folderId: moveTarget });
      setMoveDialog(null);
      await load(query, currentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de déplacement');
    }
  };

  const openDelete = (d: DeleteDialog) => {
    setMenu(null);
    setDeleteDialog(d);
    setDeleteRecursive(false);
  };

  const submitDelete = async () => {
    if (!deleteDialog) return;
    setError(null);
    try {
      if (deleteDialog.kind === 'folder') {
        await api.deleteFolder(deleteDialog.item.id, deleteRecursive);
      } else {
        await api.deleteFile(deleteDialog.item.id);
      }
      setDeleteDialog(null);
      await load(query, currentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur de suppression';
      setError(msg);
      // dossier non vide : le 409 porte les compteurs, la case récursif suffit à réessayer
      if (deleteDialog.kind === 'folder' && /non vide/i.test(msg)) {
        setDeleteDialog({ ...deleteDialog, counts: null });
      }
    }
  };

  const openDetail = async (f: FileItem) => {
    setMenu(null);
    try {
      setDetail(await api.fileDetail(f.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    }
  };

  // arbre des dossiers pour le dialogue "Déplacer…" (avec indentation)
  const moveTree = useMemo(() => {
    if (!moveDialog) return [];
    const blocked = new Set<number>();
    if (moveDialog.kind === 'folder') {
      blocked.add(moveDialog.item.id);
      const stack = [moveDialog.item.id];
      while (stack.length) {
        const id = stack.pop() as number;
        for (const f of folders) if (f.parentId === id) { blocked.add(f.id); stack.push(f.id); }
      }
    }
    const rows: { folder: Folder | null; depth: number }[] = [{ folder: null, depth: 0 }];
    const build = (parentId: number | null, depth: number) => {
      for (const f of folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
        if (blocked.has(f.id)) continue;
        rows.push({ folder: f, depth: depth + 1 });
        build(f.id, depth + 1);
      }
    };
    build(null, 0);
    return rows;
  }, [moveDialog, folders]);

  const menuTarget = menu?.target ?? null;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 620 } } }}
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" sx={{ flex: 1 }}>Espace documentaire</Typography>
          <Tooltip title="Rafraîchir">
            <IconButton onClick={() => void load(query, currentId)}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>

        <Breadcrumbs maxItems={4}>
          <Link component="button" underline="hover" onClick={() => setCurrentId(null)}>
            Accueil
          </Link>
          {breadcrumb.map((f) => (
            <Link key={f.id} component="button" underline="hover" onClick={() => setCurrentId(f.id)}>
              {f.name}
            </Link>
          ))}
        </Breadcrumbs>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Rechercher un document (tous les dossiers)…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              void load(e.target.value, currentId);
            }}
          />
          <IconButton color="primary" onClick={() => void load(query, currentId)}>
            <SearchIcon />
          </IconButton>
        </Box>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<CreateNewFolderIcon />}
            onClick={() => openNameDialog({ mode: 'new-folder' })}
          >
            Nouveau dossier
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<UploadFileIcon />}
            disabled={uploading || Boolean(query)}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? 'Envoi…' : 'Déposer ici'}
          </Button>
        </Box>
        <input hidden type="file" ref={fileRef} onChange={onPick} />
        {error && <Typography color="error" variant="caption">{error}</Typography>}

        <List sx={{ overflowY: 'auto', flex: 1 }} dense>
          {!query &&
            childFolders.map((f) => (
              <ListItem
                key={`folder-${f.id}`}
                disablePadding
                secondaryAction={
                  <IconButton
                    edge="end"
                    onClick={(e) => setMenu({ anchor: e.currentTarget, target: { kind: 'folder', item: f } })}
                  >
                    <MoreVertIcon />
                  </IconButton>
                }
              >
                <ListItemButton onClick={() => setCurrentId(f.id)}>
                  <ListItemAvatar>
                    <Avatar>
                      <FolderIcon />
                    </Avatar>
                  </ListItemAvatar>
                  <ListItemText
                    primary={f.name}
                    secondary={`dossier · créé par ${f.createdBy.name} le ${formatDateTime(f.createdAt)}${f.updatedAt ? ` · mod. ${formatDateTime(f.updatedAt)}` : ''}`}
                  />
                </ListItemButton>
              </ListItem>
            ))}

          {files.map((f) => (
            <ListItem
              key={`file-${f.id}`}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  onClick={(e) => setMenu({ anchor: e.currentTarget, target: { kind: 'file', item: f } })}
                >
                  <MoreVertIcon />
                </IconButton>
              }
            >
              <ListItemButton onDoubleClick={() => void download(f)}>
                <ListItemAvatar>
                  <Avatar>{fileIcon(f)}</Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <span>{f.name}</span>
                      {query && <Chip size="small" variant="outlined" label={folderPathOf(f.folderId)} />}
                    </Box>
                  }
                  secondary={`${formatSize(f.size)} · ${f.user.name} · créé ${formatDateTime(f.createdAt)}${f.updatedAt ? ` · mod. ${formatDateTime(f.updatedAt)}` : ''}`}
                />
              </ListItemButton>
            </ListItem>
          ))}

          {childFolders.length === 0 && files.length === 0 && (
            <ListItem>
              <ListItemText primary={query ? 'Aucun résultat' : 'Dossier vide — déposez un fichier ou créez un sous-dossier'} />
            </ListItem>
          )}
        </List>

        <Typography variant="caption" color="text.secondary">
          Les documents alimentent /ask et /solve (RAG). Fichiers audio transcrits automatiquement (STT) ; sur une
          transcription, Résumé / CR génèrent un document (LLM). Clic ⋮ : renommer, déplacer, historique, supprimer.
        </Typography>
      </Box>

      {/* menu contextuel ⋮ */}
      <Menu anchorEl={menu?.anchor ?? null} open={Boolean(menu)} onClose={() => setMenu(null)}>
        {menuTarget?.kind === 'file' && (
          <>
            <MenuItem onClick={() => void download(menuTarget.item)}>
              <ListItemIcon><DownloadIcon fontSize="small" /></ListItemIcon>Télécharger
            </MenuItem>
            {menuTarget.item.mime.startsWith('audio/') && (
              <MenuItem
                onClick={() => {
                  void transcribe(menuTarget.item);
                  setMenu(null);
                }}
              >
                <ListItemIcon><RecordVoiceOverIcon fontSize="small" /></ListItemIcon>Transcrire (STT)
              </MenuItem>
            )}
            {/transcription/i.test(menuTarget.item.name) && (
              <>
                <MenuItem
                  onClick={() => {
                    void derive(menuTarget.item, 'resume');
                    setMenu(null);
                  }}
                >
                  <ListItemIcon><SummarizeIcon fontSize="small" /></ListItemIcon>Résumé (LLM)
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void derive(menuTarget.item, 'cr');
                    setMenu(null);
                  }}
                >
                  <ListItemIcon><DescriptionIcon fontSize="small" /></ListItemIcon>Compte-rendu (LLM)
                </MenuItem>
              </>
            )}
            <MenuItem onClick={() => openNameDialog({ mode: 'rename-file', file: menuTarget.item })}>
              <ListItemIcon><RenameIcon fontSize="small" /></ListItemIcon>Renommer
            </MenuItem>
            <MenuItem onClick={() => openMove({ kind: 'file', item: menuTarget.item })}>
              <ListItemIcon><DriveFileMoveIcon fontSize="small" /></ListItemIcon>Déplacer…
            </MenuItem>
            <MenuItem onClick={() => void openDetail(menuTarget.item)}>
              <ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon>Détails & historique
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => openDelete({ kind: 'file', item: menuTarget.item })}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>Supprimer
            </MenuItem>
          </>
        )}
        {menuTarget?.kind === 'folder' && (
          <>
            <MenuItem onClick={() => openNameDialog({ mode: 'rename-folder', folder: menuTarget.item })}>
              <ListItemIcon><RenameIcon fontSize="small" /></ListItemIcon>Renommer
            </MenuItem>
            <MenuItem onClick={() => openMove({ kind: 'folder', item: menuTarget.item })}>
              <ListItemIcon><DriveFileMoveIcon fontSize="small" /></ListItemIcon>Déplacer…
            </MenuItem>
            <Divider />
            <MenuItem
              onClick={() => openDelete({ kind: 'folder', item: menuTarget.item, counts: null })}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>Supprimer
            </MenuItem>
          </>
        )}
      </Menu>

      {/* dialogue nom (nouveau dossier / renommage) */}
      <Dialog open={Boolean(nameDialog)} onClose={() => setNameDialog(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {nameDialog?.mode === 'new-folder' && 'Nouveau dossier'}
          {nameDialog?.mode === 'rename-folder' && 'Renommer le dossier'}
          {nameDialog?.mode === 'rename-file' && 'Renommer le fichier'}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitName();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNameDialog(null)}>Annuler</Button>
          <Button variant="contained" onClick={() => void submitName()} disabled={!nameValue.trim()}>
            OK
          </Button>
        </DialogActions>
      </Dialog>

      {/* dialogue déplacer */}
      <Dialog open={Boolean(moveDialog)} onClose={() => setMoveDialog(null)} fullWidth maxWidth="xs">
        <DialogTitle>Déplacer vers…</DialogTitle>
        <DialogContent sx={{ maxHeight: 360, overflowY: 'auto' }}>
          <List dense>
            {moveTree.map((row) => (
              <ListItemButton
                key={row.folder ? `f-${row.folder.id}` : 'root'}
                selected={moveTarget === (row.folder?.id ?? null)}
                onClick={() => setMoveTarget(row.folder?.id ?? null)}
                sx={{ pl: 1 + row.depth * 2 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <FolderIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={row.folder ? row.folder.name : 'Racine (Espace documentaire)'} />
              </ListItemButton>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMoveDialog(null)}>Annuler</Button>
          <Button variant="contained" onClick={() => void submitMove()}>
            Déplacer
          </Button>
        </DialogActions>
      </Dialog>

      {/* dialogue suppression */}
      <Dialog open={Boolean(deleteDialog)} onClose={() => setDeleteDialog(null)} fullWidth maxWidth="xs">
        {deleteDialog && (
          <>
            <DialogTitle sx={{ color: 'error.main' }}>Supprimer {deleteDialog.kind === 'folder' ? 'le dossier' : 'le fichier'} ?</DialogTitle>
            <DialogContent>
              <Typography variant="body2">
                {deleteDialog.kind === 'folder'
                  ? `« ${deleteDialog.item.name} » et tout son contenu seront supprimés définitivement.`
                  : `« ${deleteDialog.item.name} » sera supprimé définitivement (le fichier disparaît du disque et de la chat).`}
              </Typography>
              {deleteDialog.kind === 'folder' && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={deleteRecursive}
                      onChange={(e) => setDeleteRecursive(e.target.checked)}
                    />
                  }
                  label="Supprimer aussi tout le contenu (récursif)"
                />
              )}
            </DialogContent>
          </>
        )}
        <DialogActions>
          <Button onClick={() => setDeleteDialog(null)}>Annuler</Button>
          <Button color="error" variant="contained" onClick={() => void submitDelete()}>
            Supprimer
          </Button>
        </DialogActions>
      </Dialog>

      {/* dialogue détails + historique */}
      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="sm">
        <DialogTitle>Détails du fichier</DialogTitle>
        <DialogContent dividers>
          {detail && (
            <>
              <Typography variant="subtitle1">{detail.file.name}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {formatSize(detail.file.size)} · {detail.file.mime || 'type inconnu'}
              </Typography>
              <Typography variant="body2">Dossier : {detail.folderPath.map((f) => f.name).join(' / ') || 'Racine'}</Typography>
              <Typography variant="body2">Auteur : {detail.file.user.name}</Typography>
              <Typography variant="body2">Créé le : {formatDateTime(detail.file.createdAt)}</Typography>
              <Typography variant="body2">Dernière modification : {formatDateTime(detail.file.updatedAt)}</Typography>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="subtitle2">Journal de modifications</Typography>
              <List dense>
                {detail.history.map((e) => (
                  <ListItem key={e.id} disableGutters>
                    <ListItemText
                      primary={`${ACTION_LABELS[e.action] ?? e.action}${e.detail ? ` — ${e.detail}` : ''}`}
                      secondary={`${e.user.name} · ${formatDateTime(e.createdAt)}`}
                    />
                  </ListItem>
                ))}
                {detail.history.length === 0 && <ListItem disableGutters><ListItemText primary="Aucun événement" /></ListItem>}
              </List>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetail(null)}>Fermer</Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
}
