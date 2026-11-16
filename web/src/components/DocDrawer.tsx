import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import DriveFolderUploadOutlinedIcon from '@mui/icons-material/DriveFolderUploadOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HistoryIcon from '@mui/icons-material/History';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import MenuOutlinedIcon from '@mui/icons-material/MenuOutlined';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import RefreshIcon from '@mui/icons-material/Refresh';
import RenameIcon from '@mui/icons-material/DriveFileRenameOutline';
import SearchIcon from '@mui/icons-material/Search';
import SummarizeIcon from '@mui/icons-material/Summarize';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
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
  Popover,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, saveFile } from '../api';
import { documentsFromDrop, documentsFromPicker, importDocuments, type ExternalDocument } from '../documentImport';
import { formatFileSize } from '../formatFileSize';
import type { FileFilters, FileItem, FileSort, Folder } from '../types';
import useDocumentDrag, { documentDropAt, documentDropAttributes, documentDropStyle, type DropTarget } from '../useDocumentDrag';
import type { ChatSocket } from '../ws';
import DocumentExplorerList, { explorerColors, type DocumentItem, type DocumentView } from './DocumentExplorerList';
import DocumentPlaces, { type DocumentPlace } from './DocumentPlaces';

interface Props {
  open: boolean;
  onClose: () => void;
  socket: ChatSocket | null;
}

type NameEdit =
  | { mode: 'new-folder' }
  | { mode: 'group-files'; source: FileItem | File; target: FileItem }
  | { mode: 'rename-folder'; folder: Folder }
  | { mode: 'rename-file'; file: FileItem };

type FileDetail = Awaited<ReturnType<typeof api.fileDetail>>;
type FileListing = Awaited<ReturnType<typeof api.files>> & { scope: string };
type NavigationHistory = { places: DocumentPlace[]; index: number };

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const FILE_LIMIT = 200;
const RECENT_DAYS = 30;
const VIEW_STORAGE_KEY = 'chat.documents.view';

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
  const wide = useMediaQuery(useTheme().breakpoints.up('md'));
  const [folders, setFolders] = useState<Folder[]>([]);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [history, setHistory] = useState<NavigationHistory>({ places: [null], index: 0 });
  const [placesAnchor, setPlacesAnchor] = useState<HTMLButtonElement | null>(null);
  const [view, setView] = useState<DocumentView>(() => localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list');
  const [canPickFolder] = useState(() => 'webkitdirectory' in document.createElement('input'));
  const [query, setQuery] = useState('');
  const [folderSort, setFolderSort] = useState<FileSort>({ column: 'name', direction: 'asc' });
  const [recentSort, setRecentSort] = useState<FileSort>({ column: 'date', direction: 'desc' });
  const [filters, setFilters] = useState<FileFilters>({});
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [groupSource, setGroupSource] = useState<FileItem | null>(null);
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
  const folderRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const externalMark = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailRequest = useRef(0);
  const moreFilesRequest = useRef<AbortController | null>(null);
  const place = history.places[history.index];
  const currentId = typeof place === 'number' ? place : null;
  const search = query.trim();
  const recent = !search && place === 'recent';
  const showPaths = Boolean(search) || recent;
  const folderScope = search ? 'search:' + search : 'place:' + place;
  const sort = recent ? recentSort : folderSort;
  const fileRequest = useMemo(() => ({
    query: search,
    folderId: showPaths ? undefined : currentId,
    recentSince: recent ? Date.now() - RECENT_DAYS * 86_400_000 : undefined,
    limit: FILE_LIMIT,
    sort,
    filters,
  }), [currentId, filters, open, recent, revision, search, showPaths, sort]);
  const scope = JSON.stringify(fileRequest);
  const visibleListing = listing?.scope === scope ? listing : null;
  const reload = useCallback(() => setRevision((previous) => previous + 1), []);

  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setListError(null);

    const timer = window.setTimeout(async () => {
      try {
        const [directory, result] = await Promise.all([
          api.folders(request.signal),
          api.files(fileRequest, request.signal),
        ]);
        if (request.signal.aborted) return;
        setFolders(directory.folders);
        const existingFolders = new Set(directory.folders.map(({ id }) => id));
        setHistory((previous) => {
          const places: DocumentPlace[] = [];
          let index = 0;
          for (const [position, entry] of previous.places.entries()) {
            if ((typeof entry !== 'number' || existingFolders.has(entry)) && places[places.length - 1] !== entry) places.push(entry);
            if (position === previous.index) index = places.length - 1;
          }
          return places.length === previous.places.length ? previous : { places, index };
        });
        setListing({ scope, ...result });
      } catch (error) {
        if (!request.signal.aborted) setListError(errorMessage(error, 'Impossible de charger les documents.'));
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }, search ? 230 : 0);

    return () => {
      window.clearTimeout(timer);
      request.abort();
      moreFilesRequest.current?.abort();
      moreFilesRequest.current = null;
    };
  }, [open, fileRequest, scope, search, revision]);

  useEffect(() => {
    if (!open || !socket) return;
    return socket.onMessage((event) => {
      if (event.type === 'docsChanged' && !importing.current) reload();
    });
  }, [open, reload, socket]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [folderScope]);

  const loadMoreFiles = async () => {
    const before = visibleListing?.nextBefore;
    if (before == null || loading || moreFilesRequest.current) return;
    const request = new AbortController();
    moreFilesRequest.current = request;
    setLoadingMore(true);
    setListError(null);
    try {
      const result = await api.files({ ...fileRequest, before }, request.signal);
      if (request.signal.aborted) return;
      setListing((current) => {
        if (current?.scope !== scope || current.nextBefore !== before) return current;
        const loaded = new Set(current.files.map((file) => file.id));
        return {
          scope,
          files: [...current.files, ...result.files.filter((file) => !loaded.has(file.id))],
          nextBefore: result.nextBefore,
        };
      });
    } catch (error) {
      if (!request.signal.aborted) setListError(errorMessage(error, 'Impossible de charger la suite des fichiers.'));
    } finally {
      if (moreFilesRequest.current === request) {
        moreFilesRequest.current = null;
        setLoadingMore(false);
      }
    }
  };

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const pathFor = useCallback((id: number | null) => {
    const path: Folder[] = [];
    const seen = new Set<number>();
    for (let current = id; current !== null && !seen.has(current);) {
      seen.add(current);
      const folder = folderById.get(current);
      if (!folder) break;
      path.push(folder);
      current = folder.parentId;
    }
    return path.reverse();
  }, [folderById]);

  const foldersByParent = useMemo(() => {
    const tree = new Map<number | null, Folder[]>();
    for (const folder of folders) {
      const siblings = tree.get(folder.parentId) ?? [];
      siblings.push(folder);
      tree.set(folder.parentId, siblings);
    }
    for (const siblings of tree.values()) siblings.sort((left, right) => left.name.localeCompare(right.name, 'fr'));
    return tree;
  }, [folders]);

  const breadcrumb = useMemo(() => pathFor(currentId), [currentId, pathFor]);
  const childFolders = showPaths ? [] : foldersByParent.get(currentId) ?? [];

  const showPlace = (next: DocumentPlace) => {
    setActionError(null);
    setActionNotice(null);
    setQuery('');
    setPlacesAnchor(null);
    setHistory((previous) => previous.places[previous.index] === next ? previous : {
      places: [...previous.places.slice(0, previous.index + 1), next],
      index: previous.index + 1,
    });
  };

  const stepHistory = (direction: -1 | 1) => {
    setActionError(null);
    setQuery('');
    if (search) return;
    setHistory((previous) => {
      const index = previous.index + direction;
      return index >= 0 && index < previous.places.length ? { ...previous, index } : previous;
    });
  };

  const changeView = (next: DocumentView | null) => {
    if (!next) return;
    setView(next);
    localStorage.setItem(VIEW_STORAGE_KEY, next);
  };

  const runImport = async (documents: ExternalDocument[] | Promise<ExternalDocument[]>, target: Exclude<DropTarget, { kind: 'destination' }>) => {
    importing.current = true;
    setActionError(null);
    setActionNotice(null);
    setUploading(true);
    try {
      const items = await documents;
      if (!items.length) throw new Error('Le navigateur n’a transmis aucun fichier ni dossier.');
      let destination: number | null;
      if (target.kind === 'file') {
        const file = visibleListing?.files.find(({ id }) => id === target.id);
        if (!file) throw new Error('Le fichier cible est introuvable.');
        if (items.length === 1 && items[0].kind === 'file') {
          openGroup(items[0].file, file);
          return;
        }
        destination = file.folderId;
      } else {
        destination = target.id;
      }
      setActionNotice(await importDocuments(items, destination));
    } catch (error) {
      setActionError(errorMessage(error, 'Impossible d’importer les documents.'));
    } finally {
      importing.current = false;
      setUploading(false);
      reload();
    }
  };

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    const items = files ? documentsFromPicker(files) : [];
    event.target.value = '';
    if (!items.length || importing.current || showPaths) return;
    void runImport(items, { kind: 'folder', id: currentId });
  };

  const markExternal = useCallback((element: HTMLElement | null, group = false) => {
    if (externalMark.current !== element) externalMark.current?.removeAttribute('data-document-drop-active');
    externalMark.current = element;
    element?.setAttribute('data-document-drop-active', group ? 'group' : 'copy');
  }, []);

  useEffect(() => {
    if (!open) return;
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
      markExternal(null);
    };
  }, [open, markExternal]);

  const onExternalDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    const found = documentDropAt(event.target instanceof Element ? event.target : null);
    const accepted = found && found.target.kind !== 'destination' && !importing.current && !dialogBusy;
    event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    markExternal(accepted ? found.element : null, found?.target.kind === 'file' && event.dataTransfer.items.length === 1);
  };

  const onExternalDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    markExternal(null);
    const found = documentDropAt(event.target instanceof Element ? event.target : null);
    if (importing.current || dialogBusy) return;
    if (!found || found.target.kind === 'destination') {
      setActionError('Déposez les éléments sur un dossier ou dans son contenu.');
      return;
    }
    void runImport(documentsFromDrop(event.dataTransfer), found.target);
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
    setActionNotice(null);
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

  const openGroup = (source: FileItem | File, target: FileItem) => {
    if ('id' in source && source.id === target.id) {
      setActionError('Choisissez un autre fichier pour le regroupement.');
      return;
    }
    setGroupSource(null);
    setActionError(null);
    openNameDialog({ mode: 'group-files', source, target });
  };

  const submitName = async () => {
    if (!nameDialog) return;
    const name = nameValue.trim();
    if (!name) return;
    await runDialogAction(async () => {
      if (nameDialog.mode === 'group-files') {
        const { folder } = await api.groupFiles(name, nameDialog.target.id, 'id' in nameDialog.source ? nameDialog.source.id : nameDialog.source);
        showPlace(folder.id);
        setActionNotice('Deux fichiers regroupés dans « ' + folder.name + ' ».');
      } else if (nameDialog.mode === 'new-folder') await api.createFolder(name, currentId);
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

  const canMove = (item: DocumentItem, destination: number | null) => item.kind === 'file'
    ? item.item.folderId !== destination
    : item.item.parentId !== destination && !pathFor(destination).some(({ id }) => id === item.item.id);

  const moveDocument = async (item: DocumentItem, destination: number | null) => {
    if (item.kind === 'file') await api.patchFile(item.item.id, { folderId: destination });
    else await api.patchFolder(item.item.id, { parentId: destination });
    setActionNotice(destination === null ? 'Élément déplacé à la racine.' : 'Déplacé dans « ' + (folderById.get(destination)?.name ?? 'le dossier') + ' ».');
  };

  const submitMove = async () => {
    if (!moveDialog || !canMove(moveDialog, moveTarget)) return;
    await runDialogAction(
      () => moveDocument(moveDialog, moveTarget),
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
    if (groupSource) {
      openGroup(groupSource, file);
      return;
    }
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

  const movePath = pathFor(moveTarget);
  const moveFolders = (foldersByParent.get(moveTarget) ?? []).filter(({ id }) => moveDialog?.kind !== 'folder' || id !== moveDialog.item.id);
  const drag = useDocumentDrag({
    enabled: open && !uploading && !dialogBusy,
    canDrop: (source, target) => {
      if (target.kind === 'destination') return true;
      if (target.kind === 'folder') return canMove(source, target.id);
      return source.kind === 'file' && source.item.id !== target.id;
    },
    onDrop: (source, target) => {
      if (target.kind === 'destination') openMove(source);
      else if (target.kind === 'folder') void runFileAction(() => moveDocument(source, target.id), 'Déplacement impossible.');
      else if (source.kind === 'file') {
        const targetFile = visibleListing?.files.find(({ id }) => id === target.id);
        if (targetFile) openGroup(source.item, targetFile);
      }
    },
    onChoose: openMove,
  });

  const closeExplorer = () => {
    detailRequest.current += 1;
    setDetail(null);
    setMenu(null);
    setPlacesAnchor(null);
    setGroupSource(null);
    setActionNotice(null);
    setActionError(null);
    onClose();
  };

  const menuTarget = menu?.target;
  const editingFile = nameDialog?.mode === 'rename-file';
  const grouping = nameDialog?.mode === 'group-files' ? nameDialog : null;
  const nameDialogTitle = grouping ? 'Regrouper les fichiers' : nameDialog?.mode === 'new-folder' ? 'Nouveau dossier' : editingFile ? 'Renommer le fichier' : 'Renommer le dossier';
  const places = <DocumentPlaces foldersByParent={foldersByParent} currentPath={breadcrumb} active={search ? undefined : place} onNavigate={showPlace} />;

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
          onDragOver: onExternalDragOver,
          onDrop: onExternalDrop,
          onDragLeave: (event: React.DragEvent<HTMLElement>) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) markExternal(null);
          },
          sx: {
            width: { xs: '100%', md: 'min(1180px, calc(100% - 32px))' },
            bgcolor: explorerColors.background,
            color: explorerColors.ink,
            borderLeft: { sm: '1px solid ' + explorerColors.border },
          },
        },
      }}
    >
      <Box component="header" sx={{ px: horizontalPadding, py: 1.4, flexShrink: 0, bgcolor: explorerColors.surface, borderBottom: '1px solid ' + explorerColors.border }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 1.5 } }}>
          <Box
            sx={{
              width: 40,
              height: 40,
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
          <Typography id="doc-explorer-title" component="h2" sx={{ fontSize: { xs: '1.08rem', sm: '1.35rem' }, fontWeight: 760, lineHeight: 1.15, flex: 1, minWidth: 0, letterSpacing: '-0.025em' }}>
            Espace documentaire
          </Typography>
          <Tooltip disableInteractive title="Rafraîchir">
            <IconButton aria-label="Rafraîchir les documents" onClick={reload} sx={headerActionStyle}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip disableInteractive title="Fermer">
            <IconButton aria-label="Fermer l’espace documentaire" onClick={closeExplorer} sx={headerActionStyle}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: wide ? '218px minmax(0, 1fr)' : 'minmax(0, 1fr)', flex: 1, minHeight: 0 }}>
        {wide && (
          <Box component="aside" data-document-scroll sx={{ bgcolor: '#edf3f2', borderRight: '1px solid ' + explorerColors.border, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {places}
          </Box>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          <Box sx={{ px: horizontalPadding, py: { xs: 1.35, sm: 1.6 }, position: 'relative', flexShrink: 0, borderBottom: '1px solid ' + explorerColors.border, bgcolor: explorerColors.surface }}>
            <Box
              sx={{
                display: 'grid', alignItems: 'center', gap: 1, mb: 1.15,
                gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', sm: 'auto minmax(0, 1fr) auto' },
                gridTemplateAreas: { xs: '"navigation views" "location location"', sm: '"navigation location views"' },
              }}
            >
              <Box sx={{ gridArea: 'navigation', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                {!wide && (
                  <Tooltip disableInteractive title="Emplacements">
                    <IconButton aria-label="Afficher les emplacements" aria-haspopup="dialog" aria-expanded={Boolean(placesAnchor)} {...documentDropAttributes({ kind: 'destination' })} onClick={(event) => setPlacesAnchor(event.currentTarget)} sx={{ ...headerActionStyle, ...documentDropStyle }}>
                      <MenuOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip disableInteractive title="Précédent">
                  <span><IconButton aria-label="Précédent" disabled={!search && history.index === 0} onClick={() => stepHistory(-1)} sx={headerActionStyle}><ArrowBackIcon fontSize="small" /></IconButton></span>
                </Tooltip>
                <Tooltip disableInteractive title="Suivant">
                  <span><IconButton aria-label="Suivant" disabled={Boolean(search) || history.index === history.places.length - 1} onClick={() => stepHistory(1)} sx={headerActionStyle}><ArrowForwardIcon fontSize="small" /></IconButton></span>
                </Tooltip>
              </Box>

              <Box sx={{ gridArea: 'location', minWidth: 0, minHeight: 40, px: 1.3, display: 'flex', alignItems: 'center', overflow: 'hidden', border: '1px solid ' + explorerColors.border, borderRadius: '10px', bgcolor: '#f4f8f7' }}>
                {search ? (
                  <Typography component="h3" noWrap sx={{ fontSize: '0.83rem', fontWeight: 700 }}>Résultats dans tous les dossiers</Typography>
                ) : recent ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <HistoryIcon fontSize="small" sx={{ color: explorerColors.accent }} />
                    <Typography component="h3" sx={{ fontSize: '0.85rem', fontWeight: 750 }}>Récents</Typography>
                    <Typography variant="caption" noWrap sx={{ color: explorerColors.muted }}>{RECENT_DAYS} derniers jours</Typography>
                  </Box>
                ) : (
                  <Breadcrumbs
                    aria-label="Chemin du dossier"
                    maxItems={3}
                    sx={{ minWidth: 0, '& .MuiBreadcrumbs-ol': { flexWrap: 'nowrap', minWidth: 0 }, '& .MuiBreadcrumbs-li': { minWidth: 0 }, '& .MuiBreadcrumbs-separator': { mx: 0.55 } }}
                  >
                    <Link component="button" {...documentDropAttributes({ kind: 'folder', id: null })} aria-current={currentId === null ? 'page' : undefined} onClick={() => showPlace(null)} color="inherit" underline="hover" sx={{ display: 'flex', alignItems: 'center', gap: 0.6, fontSize: '0.83rem', fontWeight: 700, borderRadius: '5px', ...documentDropStyle }}>
                      <HomeOutlinedIcon fontSize="small" /> Racine
                    </Link>
                    {breadcrumb.map((folder) => (
                      <Link
                        key={folder.id}
                        component="button"
                        {...documentDropAttributes({ kind: 'folder', id: folder.id })}
                        aria-current={currentId === folder.id ? 'page' : undefined}
                        onClick={() => showPlace(folder.id)}
                        title={folder.name}
                        underline="hover"
                        sx={{
                          display: 'block', maxWidth: { xs: '31vw', sm: 128, xl: 205 }, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: currentId === folder.id ? explorerColors.ink : explorerColors.accent, fontSize: '0.83rem', fontWeight: currentId === folder.id ? 750 : 600,
                          borderRadius: '5px', ...documentDropStyle,
                        }}
                      >
                        {folder.name}
                      </Link>
                    ))}
                  </Breadcrumbs>
                )}
              </Box>

              <ToggleButtonGroup
                exclusive value={view} onChange={(_event, next: DocumentView | null) => changeView(next)} aria-label="Mode d’affichage"
                sx={{ gridArea: 'views', '& .MuiToggleButton-root': { width: 40, height: 40, px: 0, color: explorerColors.muted, borderColor: explorerColors.border }, '& .Mui-selected': { color: explorerColors.accent, bgcolor: explorerColors.accentSoft } }}
              >
                <ToggleButton value="list" aria-label="Vue liste" title="Vue liste"><ViewListOutlinedIcon fontSize="small" /></ToggleButton>
                <ToggleButton value="grid" aria-label="Vue grille" title="Vue grille"><GridViewOutlinedIcon fontSize="small" /></ToggleButton>
              </ToggleButtonGroup>
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}>
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
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(0, 1fr)' + (canPickFolder ? ' 42px' : ''), sm: canPickFolder ? 'auto auto 42px' : 'auto auto' }, gap: { xs: 0.7, sm: 1 } }}>
                <Button
                  variant="outlined"
                  startIcon={<CreateNewFolderOutlinedIcon />}
                  onClick={() => openNameDialog({ mode: 'new-folder' })}
                  disabled={showPaths}
                  sx={{ ...buttonStyle, color: explorerColors.accent, borderColor: explorerColors.border }}
                >
                  Nouveau dossier
                </Button>
                <Button
                  disableElevation
                  variant="contained"
                  startIcon={uploading ? <CircularProgress color="inherit" size={16} /> : <UploadFileOutlinedIcon />}
                  disabled={uploading || showPaths}
                  onClick={() => fileRef.current?.click()}
                  sx={{ ...primaryButtonStyle, whiteSpace: 'normal', lineHeight: 1.15 }}
                >
                  {uploading ? 'Dépôt en cours…' : 'Déposer des fichiers'}
                </Button>
                {canPickFolder && (
                  <Tooltip disableInteractive title="Importer un dossier">
                    <span><IconButton aria-label="Importer un dossier" disabled={uploading || showPaths} onClick={() => folderRef.current?.click()} sx={{ ...headerActionStyle, width: 42, height: 42 }}><DriveFolderUploadOutlinedIcon fontSize="small" /></IconButton></span>
                  </Tooltip>
                )}
              </Box>
              <input hidden type="file" multiple aria-label="Fichiers à déposer" ref={fileRef} onChange={onPick} />
              {canPickFolder && <input hidden type="file" multiple {...{ webkitdirectory: '' }} aria-label="Dossier à importer" ref={folderRef} onChange={onPick} />}
            </Box>
            {loading && <LinearProgress aria-label="Actualisation des documents" sx={{ position: 'absolute', height: 2, left: 0, right: 0, bottom: 0 }} />}
          </Box>

          <Box ref={contentRef} data-document-scroll {...(!showPaths ? documentDropAttributes({ kind: 'folder', id: currentId }) : {})} sx={{ px: horizontalPadding, pt: { xs: 1.55, sm: 2 }, pb: 3, flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', ...documentDropStyle }} aria-busy={loading || loadingMore}>
            {actionError && <Alert severity="error" onClose={() => setActionError(null)} sx={{ mb: 2 }}>{actionError}</Alert>}
            {actionNotice && <Alert severity="success" role="status" onClose={() => setActionNotice(null)} closeText="Fermer" sx={{ mb: 1.5 }}>{actionNotice}</Alert>}
            {groupSource && (
              <Alert severity="info" onClose={() => setGroupSource(null)} closeText="Annuler le regroupement" sx={{ mb: 1.5, overflowWrap: 'anywhere' }}>
                Choisissez le fichier à regrouper avec « {groupSource.name} ».
              </Alert>
            )}
            {listError && (
              <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={reload}>Réessayer</Button>}>
                {listError}
              </Alert>
            )}
            <DocumentExplorerList
              folders={childFolders}
              files={visibleListing?.files ?? null}
              loading={!visibleListing && !listError}
              searching={Boolean(search)}
              recent={recent}
              view={view}
              sort={sort}
              filters={filters}
              onSort={recent ? setRecentSort : setFolderSort}
              onFilter={setFilters}
              downloading={downloading}
              folderPath={(id) => pathFor(id).map((folder) => folder.name).join(' / ') || 'Racine'}
              onOpenFolder={showPlace}
              onOpenFile={(file) => void openDetail(file)}
              onDownload={(file) => void download(file)}
              onMenu={(target, anchor) => setMenu({ target, anchor })}
              drag={drag}
              dragDisabled={uploading || dialogBusy}
            />
            {visibleListing?.nextBefore != null && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                <Button onClick={() => void loadMoreFiles()} disabled={loading || loadingMore} sx={{ ...buttonStyle, color: explorerColors.accent }}>
                  {loadingMore ? 'Chargement des fichiers…' : 'Afficher plus de fichiers'}
                </Button>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {drag.preview}

      {!wide && (
        <Popover
          open={open && Boolean(placesAnchor)}
          keepMounted
          anchorEl={placesAnchor}
          onClose={() => setPlacesAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          slotProps={{ paper: { role: 'dialog', 'aria-label': 'Emplacements', sx: { bgcolor: '#edf3f2', width: 280, maxWidth: 'calc(100% - 32px)' } } }}
        >
          {places}
        </Popover>
      )}

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
            <MenuItem onClick={() => { setMenu(null); setActionError(null); setActionNotice(null); setGroupSource(menuTarget.item); }}>
              <ListItemIcon><CreateNewFolderOutlinedIcon fontSize="small" /></ListItemIcon>Regrouper avec un fichier…
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
            {grouping && (
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                « {grouping.source.name} » et « {grouping.target.name} » seront placés dans le nouveau dossier.
              </Typography>
            )}
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
              {grouping ? 'Créer et regrouper' : nameDialog?.mode === 'new-folder' ? 'Créer le dossier' : 'Enregistrer'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog {...preparedDialogProps} open={Boolean(moveDialog)} onClose={() => { if (!dialogBusy) setMoveDialog(null); }} aria-labelledby="doc-move-title">
        <DialogTitle id="doc-move-title">Déplacer vers</DialogTitle>
        <DialogContent dividers>
          {dialogError && <Alert severity="error" sx={{ mb: 1 }}>{dialogError}</Alert>}
          <Typography variant="body2" sx={{ mb: 1, overflowWrap: 'anywhere' }}>« {moveDialog?.item.name} »</Typography>
          <Breadcrumbs aria-label="Chemin de destination" maxItems={3} sx={{ mb: 1.4, overflowWrap: 'anywhere' }}>
            <Link component="button" color="inherit" disabled={dialogBusy} aria-current={moveTarget === null ? 'page' : undefined} onClick={() => setMoveTarget(null)}>Racine</Link>
            {movePath.map((folder) => (
              <Link key={folder.id} component="button" color="inherit" disabled={dialogBusy} aria-current={folder.id === moveTarget ? 'page' : undefined} onClick={() => setMoveTarget(folder.id)}>
                {folder.name}
              </Link>
            ))}
          </Breadcrumbs>
          <List component="div" dense disablePadding aria-label="Dossiers de destination">
            {moveFolders.map((folder) => (
              <ListItemButton key={folder.id} component="button" disabled={dialogBusy} onClick={() => setMoveTarget(folder.id)} sx={{ width: '100%', textAlign: 'left', borderRadius: 2, minHeight: 44 }}>
                <ListItemIcon sx={{ minWidth: 32, color: explorerColors.folder }}><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary={folder.name} sx={{ overflowWrap: 'anywhere' }} />
                <ChevronRightIcon fontSize="small" sx={{ color: explorerColors.muted }} />
              </ListItemButton>
            ))}
          </List>
          {moveFolders.length === 0 && <Typography variant="body2" sx={{ color: explorerColors.muted }}>Aucun sous-dossier.</Typography>}
        </DialogContent>
        <DialogActions>
          <Button disabled={dialogBusy} onClick={() => setMoveDialog(null)}>Annuler</Button>
          <Button variant="contained" disableElevation sx={primaryButtonStyle} disabled={dialogBusy || !moveDialog || !canMove(moveDialog, moveTarget)} onClick={() => void submitMove()}>Déplacer ici</Button>
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
