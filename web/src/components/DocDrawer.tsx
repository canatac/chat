import CloseIcon from '@mui/icons-material/Close';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryIcon from '@mui/icons-material/History';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import RefreshIcon from '@mui/icons-material/Refresh';
import RenameIcon from '@mui/icons-material/DriveFileRenameOutline';
import SearchIcon from '@mui/icons-material/Search';
import SummarizeIcon from '@mui/icons-material/Summarize';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import {
  Alert,
  Box,
  Breadcrumbs,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  Link,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, saveFile } from '../api';
import { formatFileSize } from '../formatFileSize';
import type { FileItem, Folder } from '../types';
import type { ChatSocket } from '../ws';
import DocumentExplorerList, { explorerColors, type DocumentItem } from './DocumentExplorerList';

interface Props {
  open: boolean;
  onClose: () => void;
  socket: ChatSocket | null;
}

type NameEdit =
  | { mode: 'new-folder' }
  | { mode: 'rename-folder'; folder: Folder }
  | { mode: 'rename-file'; file: FileItem };

type FileDetail = Awaited<ReturnType<typeof api.fileDetail>>;

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const FILE_LIMIT = 200;

const ACTION_LABELS: Record<string, string> = {
  file_created: 'Déposé',
  file_renamed: 'Renommé',
  file_moved: 'Déplacé',
  file_deleted: 'Supprimé',
  file_transcribed: 'Transcrit',
  file_derived: 'Résumé ou compte-rendu généré',
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const buttonStyle = {
  textTransform: 'none',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  minHeight: 42,
  borderRadius: '10px',
  '@media (max-width:359px)': {
    px: 0.75,
    fontSize: '0.79rem',
    '& .MuiButton-startIcon': { display: 'none' },
  },
};
const primaryButtonStyle = {
  ...buttonStyle,
  bgcolor: explorerColors.accent,
  '&:hover': { bgcolor: '#0d524b' },
};
const headerActionStyle = {
  color: explorerColors.muted,
  border: '1px solid ' + explorerColors.border,
  borderRadius: '10px',
  width: 40,
  height: 40,
};
const horizontalPadding = { xs: 2, sm: 3.25 };
const preparedDialogProps = { fullWidth: true, maxWidth: 'xs' as const };

export default function DocDrawer({ open, onClose, socket }: Props) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [listing, setListing] = useState<{ scope: string; files: FileItem[] } | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState<ReadonlySet<number>>(new Set());

  const [menu, setMenu] = useState<{ anchor: HTMLElement; target: DocumentItem } | null>(null);
  const [nameDialog, setNameDialog] = useState<NameEdit | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [moveDialog, setMoveDialog] = useState<DocumentItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DocumentItem | null>(null);
  const [deleteRecursive, setDeleteRecursive] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [detail, setDetail] = useState<FileDetail | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailRequest = useRef(0);
  const search = query.trim();
  const scope = search ? 'search:' + search : 'folder:' + currentId;
  const matchesScope = listing?.scope === scope;
  const reload = useCallback(() => setRevision((previous) => previous + 1), []);

  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setLoading(true);
    setListError(null);

    const timer = window.setTimeout(async () => {
      try {
        const [directory, result] = await Promise.all([
          api.folders(request.signal),
          api.files(search, undefined, FILE_LIMIT, search ? undefined : currentId, request.signal),
        ]);
        if (request.signal.aborted) return;
        setFolders(directory.folders);
        if (currentId !== null && !directory.folders.some((folder) => folder.id === currentId)) {
          setCurrentId(null);
        }
        setListing({ scope, files: result.files });
      } catch (error) {
        if (!request.signal.aborted) setListError(errorMessage(error, 'Impossible de charger les documents.'));
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }, search ? 230 : 0);

    return () => {
      window.clearTimeout(timer);
      request.abort();
    };
  }, [open, currentId, scope, search, revision]);

  useEffect(() => {
    if (!open || !socket) return;
    return socket.onMessage((event) => {
      if (event.type === 'docsChanged') reload();
    });
  }, [open, reload, socket]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [scope]);

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const pathFor = useCallback((id: number | null) => {
    const path: Folder[] = [];
    const seen = new Set<number>();
    for (let current = id; current !== null && !seen.has(current);) {
      seen.add(current);
      const folder = folderById.get(current);
      if (!folder) break;
      path.unshift(folder);
      current = folder.parentId;
    }
    return path;
  }, [folderById]);

  const breadcrumb = pathFor(currentId);
  const childFolders = search ? [] : folders
    .filter((folder) => folder.parentId === currentId)
    .sort((left, right) => left.name.localeCompare(right.name, 'fr'));

  const showFolder = (id: number | null) => {
    setActionError(null);
    setQuery('');
    setCurrentId(id);
  };

  const onPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || uploading) return;
    setActionError(null);
    setUploading(true);
    try {
      await api.uploadFile(file, '', false, currentId);
      reload();
    } catch (error) {
      setActionError(errorMessage(error, 'Impossible de déposer le fichier.'));
    } finally {
      setUploading(false);
    }
  };

  const download = async (file: FileItem) => {
    setMenu(null);
    if (downloading.has(file.id)) return;
    setActionError(null);
    setDownloading((previous) => new Set(previous).add(file.id));
    try {
      await saveFile(file);
    } catch (error) {
      setActionError(errorMessage(error, 'Impossible de télécharger le fichier.'));
    } finally {
      setDownloading((previous) => {
        const remaining = new Set(previous);
        remaining.delete(file.id);
        return remaining;
      });
    }
  };

  const runFileAction = async (action: () => Promise<unknown>, fallback: string) => {
    setMenu(null);
    setActionError(null);
    try {
      await action();
      reload();
    } catch (error) {
      setActionError(errorMessage(error, fallback));
    }
  };

  const derive = (file: FileItem, kind: 'resume' | 'cr') =>
    runFileAction(() => api.derive(file.id, kind), 'Erreur de génération.');
  const transcribe = (file: FileItem) =>
    runFileAction(() => api.transcribe(file.id), 'Erreur de transcription.');

  const runDialogAction = async (action: () => Promise<unknown>, close: () => void, fallback: string) => {
    if (dialogBusy) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await action();
      close();
      reload();
    } catch (error) {
      setDialogError(errorMessage(error, fallback));
    } finally {
      setDialogBusy(false);
    }
  };

  const openNameDialog = (edit: NameEdit) => {
    setMenu(null);
    setDialogError(null);
    setNameDialog(edit);
    setNameValue(edit.mode === 'rename-folder' ? edit.folder.name : edit.mode === 'rename-file' ? edit.file.name : '');
  };

  const submitName = async () => {
    if (!nameDialog) return;
    const name = nameValue.trim();
    if (!name) return;
    await runDialogAction(async () => {
      if (nameDialog.mode === 'new-folder') await api.createFolder(name, currentId);
      else if (nameDialog.mode === 'rename-folder') await api.patchFolder(nameDialog.folder.id, { name });
      else await api.patchFile(nameDialog.file.id, { name });
    }, () => setNameDialog(null), 'Impossible d’enregistrer ce nom.');
  };

  const openMove = (target: DocumentItem) => {
    setMenu(null);
    setDialogError(null);
    setMoveDialog(target);
    setMoveTarget(target.kind === 'folder' ? target.item.parentId : target.item.folderId);
  };

  const submitMove = async () => {
    if (!moveDialog) return;
    await runDialogAction(
      () => moveDialog.kind === 'folder'
        ? api.patchFolder(moveDialog.item.id, { parentId: moveTarget })
        : api.patchFile(moveDialog.item.id, { folderId: moveTarget }),
      () => setMoveDialog(null),
      'Déplacement impossible.',
    );
  };

  const openDelete = (target: DocumentItem) => {
    setMenu(null);
    setDialogError(null);
    setDeleteDialog(target);
    setDeleteRecursive(false);
  };

  const submitDelete = async () => {
    if (!deleteDialog) return;
    await runDialogAction(
      () => deleteDialog.kind === 'folder'
        ? api.deleteFolder(deleteDialog.item.id, deleteRecursive)
        : api.deleteFile(deleteDialog.item.id),
      () => setDeleteDialog(null),
      'Suppression impossible.',
    );
  };

  const openDetail = async (file: FileItem) => {
    setMenu(null);
    setActionError(null);
    const requestId = ++detailRequest.current;
    try {
      const loaded = await api.fileDetail(file.id);
      if (requestId === detailRequest.current) setDetail(loaded);
    } catch (error) {
      if (requestId === detailRequest.current) setActionError(errorMessage(error, 'Impossible de charger les détails.'));
    }
  };

  const moveTree = useMemo(() => {
    if (!moveDialog) return [];
    const tree = new Map<number | null, Folder[]>();
    for (const folder of folders) {
      const siblings = tree.get(folder.parentId) ?? [];
      siblings.push(folder);
      tree.set(folder.parentId, siblings);
    }
    const rows: { folder: Folder | null; depth: number }[] = [{ folder: null, depth: 0 }];
    const blockedId = moveDialog.kind === 'folder' ? moveDialog.item.id : null;
    const addChildren = (parent: number | null, depth: number) => {
      const siblings = tree.get(parent) ?? [];
      siblings.sort((left, right) => left.name.localeCompare(right.name, 'fr'));
      for (const folder of siblings) {
        if (folder.id === blockedId) continue;
        rows.push({ folder, depth });
        addChildren(folder.id, depth + 1);
      }
    };
    addChildren(null, 1);
    return rows;
  }, [moveDialog, folders]);

  const closeExplorer = () => {
    detailRequest.current += 1;
    setDetail(null);
    setMenu(null);
    setActionError(null);
    onClose();
  };

  const menuTarget = menu?.target;
  const editingFile = nameDialog?.mode === 'rename-file';
  const nameDialogTitle = nameDialog?.mode === 'new-folder' ? 'Nouveau dossier' : editingFile ? 'Renommer le fichier' : 'Renommer le dossier';

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={closeExplorer}
      slotProps={{
        backdrop: { sx: { bgcolor: 'rgba(13, 34, 39, 0.42)' } },
        paper: {
          role: 'dialog',
          'aria-modal': true,
          'aria-labelledby': 'doc-explorer-title',
          sx: {
            width: { xs: '100%', sm: 'min(850px, calc(100% - 32px))' },
            bgcolor: explorerColors.background,
            color: explorerColors.ink,
            borderLeft: { sm: '1px solid ' + explorerColors.border },
          },
        },
      }}
    >
      <Box component="header" sx={{ px: horizontalPadding, pt: { xs: 2, sm: 3 }, pb: { xs: 2, sm: 2.5 }, bgcolor: explorerColors.surface, borderBottom: '1px solid ' + explorerColors.border }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 1.5 }, mb: { xs: 1.75, sm: 2.4 } }}>
          <Box
            sx={{
              width: { xs: 39, sm: 48 },
              height: { xs: 39, sm: 48 },
              flexShrink: 0,
              borderRadius: '13px',
              bgcolor: explorerColors.accentSoft,
              color: explorerColors.accent,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <FolderOpenOutlinedIcon />
          </Box>
          <Typography id="doc-explorer-title" component="h2" sx={{ fontSize: { xs: '1.17rem', sm: '1.55rem' }, fontWeight: 760, lineHeight: 1.15, flex: 1, minWidth: 0, letterSpacing: '-0.025em' }}>
            Espace documentaire
          </Typography>
          <Tooltip title="Rafraîchir">
            <IconButton aria-label="Rafraîchir les documents" onClick={reload} sx={headerActionStyle}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Fermer">
            <IconButton aria-label="Fermer l’espace documentaire" onClick={closeExplorer} sx={headerActionStyle}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) auto' }, gap: 1.2 }}>
          <TextField
            size="small"
            fullWidth
            value={query}
            placeholder="Rechercher un fichier…"
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{
              htmlInput: { maxLength: 100, 'aria-label': 'Rechercher dans tous les dossiers' },
              input: {
                startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" sx={{ color: explorerColors.muted }} /></InputAdornment>,
                endAdornment: query ? (
                  <InputAdornment position="end">
                    <IconButton aria-label="Effacer la recherche" size="small" onClick={() => setQuery('')}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
            sx={{
              '& .MuiOutlinedInput-root': { height: 42, borderRadius: '10px', bgcolor: '#f6f9f9' },
              '& .MuiOutlinedInput-notchedOutline': { borderColor: explorerColors.border },
              '& input::placeholder': { color: explorerColors.muted, opacity: 1 },
            }}
          />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(0, 1fr)', sm: 'auto auto' }, justifyContent: { sm: 'end' }, gap: 1 }}>
            <Button
              variant="outlined"
              startIcon={<CreateNewFolderOutlinedIcon />}
              onClick={() => openNameDialog({ mode: 'new-folder' })}
              disabled={Boolean(search)}
              sx={{ ...buttonStyle, color: explorerColors.accent, borderColor: explorerColors.border }}
            >
              Nouveau dossier
            </Button>
            <Button
              disableElevation
              variant="contained"
              startIcon={uploading ? <CircularProgress color="inherit" size={16} /> : <UploadFileOutlinedIcon />}
              disabled={uploading || Boolean(search)}
              onClick={() => fileRef.current?.click()}
              sx={primaryButtonStyle}
            >
              {uploading ? 'Dépôt en cours…' : 'Déposer un fichier'}
            </Button>
          </Box>
          <input hidden type="file" ref={fileRef} onChange={onPick} />
        </Box>
      </Box>

      <Box sx={{ position: 'relative', flexShrink: 0, px: horizontalPadding, py: 1.5, borderBottom: '1px solid ' + explorerColors.border }}>
        {search ? (
          <Typography component="h3" sx={{ fontSize: '0.85rem', fontWeight: 700 }}>Résultats dans tous les dossiers</Typography>
        ) : (
          <Breadcrumbs
            aria-label="Chemin du dossier"
            maxItems={4}
            sx={{ '& .MuiBreadcrumbs-ol': { flexWrap: 'nowrap', minWidth: 0 }, '& .MuiBreadcrumbs-li': { minWidth: 0 }, '& .MuiBreadcrumbs-separator': { mx: 0.75 } }}
          >
            <Link
              component="button"
              aria-current={currentId === null ? 'page' : undefined}
              onClick={() => showFolder(null)}
              color="inherit"
              underline="hover"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.65, fontSize: '0.85rem', fontWeight: 700 }}
            >
              <HomeOutlinedIcon fontSize="small" /> Racine
            </Link>
            {breadcrumb.map((folder) => (
              <Link
                key={folder.id}
                component="button"
                aria-current={currentId === folder.id ? 'page' : undefined}
                onClick={() => showFolder(folder.id)}
                title={folder.name}
                underline="hover"
                sx={{
                  display: 'block',
                  maxWidth: { xs: '34vw', sm: 210 },
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: currentId === folder.id ? explorerColors.ink : explorerColors.accent,
                  fontSize: '0.85rem',
                  fontWeight: currentId === folder.id ? 750 : 600,
                }}
              >
                {folder.name}
              </Link>
            ))}
          </Breadcrumbs>
        )}
        {loading && <LinearProgress aria-label="Actualisation des documents" sx={{ position: 'absolute', height: 2, left: 0, right: 0, bottom: 0 }} />}
      </Box>

      <Box ref={contentRef} sx={{ px: horizontalPadding, pt: { xs: 2, sm: 2.5 }, pb: 3, flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }} aria-busy={loading}>
        {actionError && <Alert severity="error" onClose={() => setActionError(null)} sx={{ mb: 2 }}>{actionError}</Alert>}
        {listError && (
          <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={reload}>Réessayer</Button>}>
            {listError}
          </Alert>
        )}
        {matchesScope ? (
          <DocumentExplorerList
            folders={childFolders}
            files={listing.files}
            searching={Boolean(search)}
            downloading={downloading}
            folderPath={(id) => pathFor(id).map((folder) => folder.name).join(' / ') || 'Racine'}
            onOpenFolder={showFolder}
            onOpenFile={(file) => void openDetail(file)}
            onDownload={(file) => void download(file)}
            onMenu={(target, anchor) => setMenu({ target, anchor })}
          />
        ) : !listError && (
          <Box aria-hidden="true" sx={{ display: 'grid', gap: 1.1 }}>
            {[0, 1, 2].map((row) => <Skeleton key={row} variant="rounded" height={62} />)}
          </Box>
        )}
      </Box>

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
              onClick={() => openDelete({ kind: 'folder', item: menuTarget.item })}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>Supprimer
            </MenuItem>
          </>
        )}
      </Menu>

      <Dialog
        {...preparedDialogProps}
        open={Boolean(nameDialog)}
        onClose={() => { if (!dialogBusy) setNameDialog(null); }}
        aria-labelledby="doc-name-title"
      >
        <Box component="form" onSubmit={(event) => { event.preventDefault(); void submitName(); }}>
          <DialogTitle id="doc-name-title">{nameDialogTitle}</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label={editingFile ? 'Nom du fichier' : 'Nom du dossier'}
              sx={{ mt: 1 }}
              value={nameValue}
              disabled={dialogBusy}
              error={Boolean(dialogError)}
              helperText={dialogError}
              onChange={(event) => { setNameValue(event.target.value); setDialogError(null); }}
              slotProps={{ htmlInput: { maxLength: editingFile ? 255 : 120 } }}
            />
          </DialogContent>
          <DialogActions>
            <Button disabled={dialogBusy} onClick={() => setNameDialog(null)}>Annuler</Button>
            <Button type="submit" variant="contained" disableElevation sx={primaryButtonStyle} disabled={dialogBusy || !nameValue.trim()}>
              {nameDialog?.mode === 'new-folder' ? 'Créer le dossier' : 'Enregistrer'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog {...preparedDialogProps} open={Boolean(moveDialog)} onClose={() => { if (!dialogBusy) setMoveDialog(null); }} aria-labelledby="doc-move-title">
        <DialogTitle id="doc-move-title">Déplacer vers</DialogTitle>
        <DialogContent dividers>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          <List dense disablePadding aria-label="Dossier de destination">
            {moveTree.map((row) => {
              const id = row.folder?.id ?? null;
              return (
                <ListItemButton
                  key={id ?? 'root'}
                  selected={id === moveTarget}
                  aria-current={id === moveTarget ? 'true' : undefined}
                  disabled={dialogBusy}
                  onClick={() => setMoveTarget(id)}
                  sx={{ pl: 1.5 + Math.min(5, row.depth) * 2, borderRadius: 2, minHeight: 42 }}
                >
                  <ListItemIcon sx={{ minWidth: 32, color: explorerColors.folder }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
                  <ListItemText primary={row.folder?.name ?? 'Racine'} sx={{ overflowWrap: 'anywhere' }} />
                </ListItemButton>
              );
            })}
          </List>
        </DialogContent>
        <DialogActions>
          <Button disabled={dialogBusy} onClick={() => setMoveDialog(null)}>Annuler</Button>
          <Button variant="contained" disableElevation sx={primaryButtonStyle} disabled={dialogBusy} onClick={() => void submitMove()}>Déplacer</Button>
        </DialogActions>
      </Dialog>

      <Dialog {...preparedDialogProps} open={Boolean(deleteDialog)} onClose={() => { if (!dialogBusy) setDeleteDialog(null); }} aria-labelledby="doc-delete-title">
        <DialogTitle id="doc-delete-title">Supprimer {deleteDialog?.kind === 'folder' ? 'le dossier' : 'le fichier'} ?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            « {deleteDialog?.item.name} » sera supprimé définitivement.
          </Typography>
          {deleteDialog?.kind === 'folder' && (
            <FormControlLabel
              disabled={dialogBusy}
              control={<Checkbox checked={deleteRecursive} onChange={(event) => setDeleteRecursive(event.target.checked)} />}
              label="Supprimer aussi le contenu du dossier"
            />
          )}
          {dialogError && <Alert severity="error" sx={{ mt: 1 }}>{dialogError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button disabled={dialogBusy} onClick={() => setDeleteDialog(null)}>Annuler</Button>
          <Button color="error" variant="contained" disableElevation disabled={dialogBusy} onClick={() => void submitDelete()}>Supprimer</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(detail)} onClose={() => setDetail(null)} fullWidth maxWidth="sm" aria-labelledby="doc-detail-title">
        <DialogTitle id="doc-detail-title">Détails du fichier</DialogTitle>
        <DialogContent dividers>
          {detail && (
            <>
              <Typography variant="subtitle1" sx={{ fontWeight: 750, overflowWrap: 'anywhere', mb: 1.5 }}>{detail.file.name}</Typography>
              <Box
                component="dl"
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '96px minmax(0, 1fr)', sm: '136px minmax(0, 1fr)' },
                  gap: 0.75,
                  m: 0,
                  mb: 2.5,
                  p: 1.75,
                  borderRadius: 2,
                  bgcolor: explorerColors.background,
                  fontSize: '0.86rem',
                  '& dt': { color: explorerColors.muted },
                  '& dd': { m: 0, minWidth: 0, overflowWrap: 'anywhere' },
                }}
              >
                <dt>Dossier</dt><dd>{detail.folderPath.map((folder) => folder.name).join(' / ') || 'Racine'}</dd>
                <dt>Auteur</dt><dd>{detail.file.user.name}</dd>
                <dt>Taille</dt><dd>{formatFileSize(detail.file.size)}</dd>
                <dt>Type</dt><dd>{detail.file.mime}</dd>
                <dt>Créé le</dt><dd>{dateTime.format(new Date(detail.file.createdAt))}</dd>
                {detail.file.updatedAt && <><dt>Modifié le</dt><dd>{dateTime.format(new Date(detail.file.updatedAt))}</dd></>}
              </Box>
              <Typography component="h3" variant="subtitle2" sx={{ fontWeight: 750 }}>Historique</Typography>
              <List dense>
                {detail.history.map((entry) => (
                  <ListItem key={entry.id} disableGutters>
                    <ListItemText
                      sx={{ overflowWrap: 'anywhere' }}
                      primary={ACTION_LABELS[entry.action] ?? entry.action}
                      secondary={[entry.user.name, dateTime.format(new Date(entry.createdAt)), entry.detail].filter(Boolean).join(' · ')}
                    />
                  </ListItem>
                ))}
                {detail.history.length === 0 && <ListItem disableGutters><ListItemText secondary="Aucun événement enregistré." /></ListItem>}
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
