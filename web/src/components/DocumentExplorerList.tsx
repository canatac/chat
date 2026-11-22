import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import AudioFileOutlinedIcon from '@mui/icons-material/AudioFileOutlined';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import SearchOffOutlinedIcon from '@mui/icons-material/SearchOffOutlined';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import { Box, Button, ButtonBase, CircularProgress, IconButton, Skeleton, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { formatFileSize } from '../formatFileSize';
import { chatColors } from '../theme';
import type { FileFilters, FileItem, FileSort, Folder } from '../types';
import { documentDropAttributes, documentDropStyle } from '../useDocumentDrag';
import type useDocumentDrag from '../useDocumentDrag';
import type { SelectedDocuments } from '../useDocumentSelection';
import DocumentColumnControls from './DocumentColumnControls';
import DocumentAnalysis from './DocumentAnalysis';

export const explorerColors = {
  ...chatColors,
  folder: '#865917',
  folderSoft: '#fcf0dc',
};

export type DocumentItem = { kind: 'folder'; item: Folder } | { kind: 'file'; item: FileItem };
export type DocumentView = 'list' | 'grid';

interface Props {
  folders: Folder[];
  files: FileItem[] | null;
  loading: boolean;
  searching: boolean;
  recent: boolean;
  view: DocumentView;
  sort: FileSort;
  filters: FileFilters;
  onSort: (sort: FileSort) => void;
  onFilter: (filters: FileFilters) => void;
  downloading: ReadonlySet<number>;
  folderPath: (id: number | null) => string;
  onOpenFolder: (id: number) => void;
  onOpenFile: (file: FileItem) => void;
  onDownload: (file: FileItem) => void;
  onMenu: (target: DocumentItem, anchor: HTMLElement) => void;
  drag: Pick<ReturnType<typeof useDocumentDrag>, 'handle' | 'surface'>;
  dragDisabled: boolean;
  selection: SelectedDocuments | null;
  onStartSelection: () => void;
  onToggleSelection: (target: DocumentItem) => void;
}

const dayFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fileColumns = 'minmax(0, 1fr) 116px 102px 128px';

const actionStyle = {
  color: explorerColors.muted,
  width: 40,
  height: 40,
  borderRadius: '9px',
  '&:hover': { bgcolor: explorerColors.accentSoft, color: explorerColors.accent },
  '&.Mui-focusVisible': { outline: '2px solid ' + explorerColors.accent, outlineOffset: -2 },
  '@media (max-width:359px)': { width: 36 },
};

const rowStyle = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr) 112px', md: fileColumns },
  '@media (max-width:359px)': { gridTemplateColumns: 'minmax(0, 1fr) 106px' },
  alignItems: 'center',
  minWidth: 0,
  px: 0.5,
  py: 0.25,
  '& + &': { borderTop: '1px solid ' + explorerColors.border },
};

const cardStyle = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  border: '1px solid ' + explorerColors.border,
  borderRadius: '12px',
  bgcolor: explorerColors.surface,
};

function IconTile({ children, color, background, grid }: { children: ReactNode; color: string; background: string; grid: boolean }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'grid', placeItems: 'center', width: grid ? 56 : 38, height: grid ? 56 : 38, flexShrink: 0,
        borderRadius: grid ? '14px' : '10px', color, bgcolor: background,
        '& .MuiSvgIcon-root': { fontSize: grid ? 34 : 22 },
        '@media (max-width:359px)': { width: grid ? 52 : 34, height: grid ? 52 : 34 },
      }}
    >
      {children}
    </Box>
  );
}

function DocumentIcon({ target, grid }: { target: DocumentItem; grid: boolean }) {
  if (target.kind === 'folder') {
    return <IconTile grid={grid} color={explorerColors.folder} background={explorerColors.folderSoft}><FolderOutlinedIcon /></IconTile>;
  }
  const { mime } = target.item;
  if (mime.startsWith('audio/')) {
    return <IconTile grid={grid} color="#644690" background="#efeafa"><AudioFileOutlinedIcon /></IconTile>;
  }
  if (mime.startsWith('video/')) {
    return <IconTile grid={grid} color="#375883" background="#e9effa"><MovieOutlinedIcon /></IconTile>;
  }
  if (mime.startsWith('image/')) {
    return <IconTile grid={grid} color="#2b6a72" background="#e3f1f3"><ImageOutlinedIcon /></IconTile>;
  }
  if (mime === 'application/pdf') {
    return <IconTile grid={grid} color="#a03b36" background="#fbeae8"><PictureAsPdfOutlinedIcon /></IconTile>;
  }
  return <IconTile grid={grid} color={explorerColors.accent} background={explorerColors.accentSoft}><ArticleOutlinedIcon /></IconTile>;
}

function DocumentName({ name, grid }: { name: string; grid: boolean }) {
  if (grid) {
    return (
      <Typography
        component="span"
        aria-hidden="true"
        sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere', lineHeight: 1.3, fontWeight: 700, fontSize: '0.86rem' }}
      >
        {name}
      </Typography>
    );
  }
  const characters = Array.from(name);
  const splitAt = characters.length > 38 ? characters.length - 13 : characters.length;
  return (
    <Box component="span" aria-hidden="true" sx={{ display: 'flex', minWidth: 0, fontWeight: 700, fontSize: '0.89rem' }}>
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre' }}>
        {characters.slice(0, splitAt).join('')}
      </Box>
      <Box component="span" sx={{ flexShrink: 0, whiteSpace: 'pre' }}>
        {characters.slice(splitAt).join('')}
      </Box>
    </Box>
  );
}

type EntryProps = Pick<Props, 'onOpenFolder' | 'onOpenFile' | 'onDownload' | 'onMenu' | 'drag' | 'dragDisabled'> & {
  target: DocumentItem;
  grid: boolean;
  description: string;
  isDownloading: boolean;
  selected?: boolean;
  onSelect: () => void;
};

function DocumentEntry({ target, grid, description, isDownloading, onOpenFolder, onOpenFile, onDownload, onMenu, drag, dragDisabled, selected, onSelect }: EntryProps) {
  const { item } = target;
  const file = target.kind === 'file' ? target.item : null;
  const date = dayFormatter.format(new Date(item.updatedAt ?? item.createdAt));
  const size = file ? formatFileSize(file.size) : '';
  const selectable = selected !== undefined;
  const SelectionIcon = selected ? CheckBoxIcon : CheckBoxOutlineBlankIcon;
  const activate = selectable ? onSelect : () => file ? onOpenFile(file) : onOpenFolder(item.id);
  return (
    <Box component="li" {...documentDropAttributes({ kind: target.kind, id: item.id })} sx={{ ...(grid ? cardStyle : rowStyle), ...(selected && { bgcolor: explorerColors.accentSoft }), ...documentDropStyle }}>
      <ButtonBase
        role={selectable ? 'checkbox' : undefined}
        aria-checked={selected}
        aria-label={(selectable ? 'Sélectionner ' : file ? 'Détails de ' : 'Ouvrir le dossier ') + item.name}
        title={item.name}
        {...drag.surface(target, activate)}
        sx={{
          position: 'relative',
          display: 'flex', flexDirection: grid ? 'column' : 'row', alignItems: 'center',
          justifyContent: grid ? 'center' : 'flex-start', flex: grid ? 1 : undefined,
          gap: grid ? 1 : 1.2, minWidth: 0, width: '100%', minHeight: grid ? 146 : 58, p: grid ? 1 : 0.9,
          textAlign: grid ? 'center' : 'left', color: explorerColors.ink, borderRadius: '9px',
          '&:hover': { bgcolor: '#f1f7f6' },
          '&.Mui-focusVisible': { outline: '2px solid ' + explorerColors.accent, outlineOffset: -2 },
        }}
      >
        {(!selectable || grid) && <DocumentIcon target={target} grid={grid} />}
        {selectable && <SelectionIcon sx={{ flexShrink: 0, color: selected ? explorerColors.accent : explorerColors.muted, ...(grid ? { position: 'absolute', top: 7, left: 7 } : { mx: 0.7 }), fontSize: 22 }} />}
        <Box component="span" sx={{ display: 'block', minWidth: 0, width: grid ? '100%' : undefined, flex: grid ? undefined : 1 }}>
          <DocumentName name={item.name} grid={grid} />
          {file && <DocumentAnalysis analysis={file.analysis} />}
          <Typography component="span" variant="caption" noWrap display="block" title={description} sx={{ color: explorerColors.muted }}>
            {description}
          </Typography>
          <Typography component="span" variant="caption" sx={{ color: explorerColors.muted, display: grid ? 'block' : { xs: 'block', md: 'none' } }}>
            {size ? size + ' · ' + date : date}
          </Typography>
        </Box>
      </ButtonBase>
      {!grid && (
        <>
          <Typography component="span" variant="caption" sx={{ color: explorerColors.muted, display: { xs: 'none', md: 'block' } }}>{date}</Typography>
          <Typography component="span" variant="caption" sx={{ color: explorerColors.muted, display: { xs: 'none', md: 'block' } }}>{size || '—'}</Typography>
        </>
      )}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', px: grid ? 0.3 : 0 }}>
        <Tooltip disableInteractive disableTouchListener title="Glisser ou choisir le dossier de destination">
          <span>
            <IconButton
              aria-label={'Déplacer ' + item.name}
              disableRipple
              disabled={dragDisabled}
              {...drag.handle(target)}
              sx={{ ...actionStyle, width: 32, '@media (max-width:359px)': { width: 32 }, touchAction: 'none', cursor: 'grab', '&:active': { cursor: 'grabbing' }, userSelect: 'none' }}
            >
              <DragIndicatorIcon sx={{ fontSize: 19 }} />
            </IconButton>
          </span>
        </Tooltip>
        {file && (
          <Tooltip disableInteractive title={isDownloading ? 'Téléchargement en cours' : 'Télécharger'}>
            <span>
              <IconButton aria-label={'Télécharger ' + file.name} disabled={isDownloading} onClick={() => onDownload(file)} sx={actionStyle}>
                {isDownloading ? <CircularProgress size={17} /> : <DownloadOutlinedIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip disableInteractive title="Plus d’actions">
          <IconButton
            aria-label={'Actions du ' + (file ? 'fichier ' : 'dossier ') + item.name}
            aria-haspopup="menu"
            onClick={(event) => onMenu(target, event.currentTarget)}
            sx={actionStyle}
          >
            <MoreHorizIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

function EmptyFiles({ searching, filtered, recent }: { searching: boolean; filtered: boolean; recent: boolean }) {
  const noResults = searching || filtered || recent;
  return (
    <Box sx={{ p: 4, textAlign: 'center' }}>
      <Box sx={{ mx: 'auto', mb: 1.4, width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: '12px', color: explorerColors.accent, bgcolor: explorerColors.accentSoft }}>
        {noResults ? <SearchOffOutlinedIcon /> : <FolderOpenOutlinedIcon />}
      </Box>
      <Typography component="h3" sx={{ color: explorerColors.ink, fontWeight: 750, mb: 0.35 }}>
        {filtered || searching ? 'Aucun résultat' : recent ? 'Aucun fichier récent' : 'Ce dossier est vide'}
      </Typography>
      {(filtered || searching || !recent) && (
        <Typography variant="body2" sx={{ color: explorerColors.muted }}>
          {filtered ? 'Modifiez ou effacez les filtres.' : searching ? 'Essayez un autre mot-clé.' : 'Déposez un fichier ou créez un dossier.'}
        </Typography>
      )}
    </Box>
  );
}

export default function DocumentExplorerList({
  folders, files, loading, searching, recent, view, sort, filters, onSort, onFilter,
  downloading, folderPath, onOpenFolder, onOpenFile, onDownload, onMenu, drag, dragDisabled,
  selection, onStartSelection, onToggleSelection,
}: Props) {
  const grid = view === 'grid';
  const filtered = Object.values(filters).some((value) => value !== undefined);
  const direction = sort.direction === 'asc' ? 1 : -1;
  const orderedFolders = [...folders].sort((left, right) => {
    const alphabetical = left.name.localeCompare(right.name, 'fr', { sensitivity: 'base' });
    if (sort.column === 'date') {
      return (Date.parse(left.updatedAt ?? left.createdAt) - Date.parse(right.updatedAt ?? right.createdAt)) * direction || alphabetical;
    }
    return sort.column === 'name' ? alphabetical * direction : alphabetical;
  });
  const entries: DocumentItem[] = [
    ...orderedFolders.map((item): DocumentItem => ({ kind: 'folder', item })),
    ...(files ?? []).map((item): DocumentItem => ({ kind: 'file', item })),
  ];
  const counts = [
    folders.length ? folders.length + (folders.length === 1 ? ' dossier' : ' dossiers') : '',
    files ? files.length + (files.length < 2 ? ' fichier' : ' fichiers') : '',
  ].filter(Boolean).join(' · ');

  return (
    <Box component="section" aria-label="Contenu documentaire">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minHeight: 29, mb: 0.65 }}>
        <Typography role="status" variant="caption" sx={{ color: explorerColors.muted, fontWeight: 650 }}>{counts}</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {filtered && (
            <Button size="small" onClick={() => onFilter({})} sx={{ textTransform: 'none', color: explorerColors.accent, fontWeight: 700 }}>
              Effacer les filtres
            </Button>
          )}
          {selection === null && (
            <Button size="small" startIcon={<SelectAllIcon />} onClick={onStartSelection} disabled={!entries.length || loading || dragDisabled} sx={{ minHeight: 36, textTransform: 'none', color: explorerColors.accent, fontWeight: 700 }}>
              Sélectionner
            </Button>
          )}
        </Box>
      </Box>
      <Box sx={{ border: '1px solid ' + explorerColors.border, borderRadius: '12px', bgcolor: explorerColors.surface, overflow: 'hidden' }}>
        <DocumentColumnControls desktopColumns={grid ? 'repeat(3, minmax(0, 120px))' : fileColumns} sort={sort} filters={filters} onSort={onSort} onFilter={onFilter} />
        {entries.length > 0 && (
          <Box
            component="ul"
            aria-label={grid ? 'Documents en grille' : 'Documents en liste'}
            sx={{
              listStyle: 'none', m: 0, p: grid ? 1.15 : 0,
              display: grid ? 'grid' : 'block', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 130px), 1fr))',
              gap: 1, bgcolor: grid ? '#f7faf9' : explorerColors.surface,
            }}
          >
            {entries.map((target) => {
              const description = target.kind === 'folder' ? target.item.createdBy.name
                : searching || recent ? folderPath(target.item.folderId) : target.item.user.name;
              return (
                <DocumentEntry
                  key={target.kind + '-' + target.item.id}
                  target={target}
                  grid={grid}
                  description={description}
                  isDownloading={target.kind === 'file' && downloading.has(target.item.id)}
                  onOpenFolder={onOpenFolder}
                  onOpenFile={onOpenFile}
                  onDownload={onDownload}
                  onMenu={onMenu}
                  drag={drag}
                  dragDisabled={dragDisabled}
                  selected={selection && (target.kind === 'file' || !filtered) ? selection[target.kind].has(target.item.id) : undefined}
                  onSelect={() => onToggleSelection(target)}
                />
              );
            })}
          </Box>
        )}
        {loading && (
          <Box aria-hidden="true" sx={{ display: 'grid', p: 1, gap: 1 }}>
            {[0, 1, 2].map((row) => <Skeleton key={row} variant="rounded" height={52} />)}
          </Box>
        )}
        {files && entries.length === 0 && <EmptyFiles searching={searching} filtered={filtered} recent={recent} />}
        {filtered && files?.length === 0 && folders.length > 0 && (
          <Typography variant="body2" sx={{ px: 1.5, py: 2, color: explorerColors.muted, borderTop: '1px solid ' + explorerColors.border }}>
            Aucun fichier ne correspond aux filtres.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
