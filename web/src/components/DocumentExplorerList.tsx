import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import AudioFileOutlinedIcon from '@mui/icons-material/AudioFileOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import SearchOffOutlinedIcon from '@mui/icons-material/SearchOffOutlined';
import { Box, ButtonBase, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { chatColors } from '../theme';
import { formatFileSize } from '../formatFileSize';
import type { FileItem, Folder } from '../types';

export const explorerColors = {
  ...chatColors,
  folder: '#865917',
  folderSoft: '#fcf0dc',
};

export type DocumentItem = { kind: 'folder'; item: Folder } | { kind: 'file'; item: FileItem };

interface Props {
  folders: Folder[];
  files: FileItem[];
  searching: boolean;
  downloading: ReadonlySet<number>;
  folderPath: (id: number | null) => string;
  onOpenFolder: (id: number) => void;
  onOpenFile: (file: FileItem) => void;
  onDownload: (file: FileItem) => void;
  onMenu: (target: DocumentItem, anchor: HTMLElement) => void;
}

const dayFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fileColumns = 'minmax(0, 1fr) 106px 70px 94px';

const actionStyle = {
  color: explorerColors.muted,
  width: 40,
  height: 40,
  borderRadius: '9px',
  '&:hover': { bgcolor: explorerColors.accentSoft, color: explorerColors.accent },
  '&.Mui-focusVisible': { outline: '2px solid ' + explorerColors.accent, outlineOffset: -2 },
  '@media (max-width:359px)': { width: 36, height: 40 },
};

const itemButtonStyle = {
  p: 1.25,
  width: '100%',
  minWidth: 0,
  gap: 1.25,
  borderRadius: '11px',
  justifyContent: 'flex-start',
  textAlign: 'left',
  '&:hover': { bgcolor: '#f1f7f6' },
  '@media (max-width:359px)': { gap: 0.75 },
  '&.Mui-focusVisible': { outline: '2px solid ' + explorerColors.accent, outlineOffset: -2 },
};

function FileIcon({ mime }: { mime: string }) {
  if (mime.startsWith('audio/')) {
    return <IconTile color="#644690" background="#efeafa"><AudioFileOutlinedIcon fontSize="small" /></IconTile>;
  }
  if (mime === 'application/pdf') {
    return <IconTile color="#a03b36" background="#fbeae8"><PictureAsPdfOutlinedIcon fontSize="small" /></IconTile>;
  }
  return <IconTile color={explorerColors.accent} background={explorerColors.accentSoft}><ArticleOutlinedIcon fontSize="small" /></IconTile>;
}

function IconTile({ children, color, background }: { children: ReactNode; color: string; background: string }) {
  return (
    <Box
      component="span"
      sx={{ display: 'grid', placeItems: 'center', width: 40, height: 40, flexShrink: 0, borderRadius: '11px', color, bgcolor: background, '@media (max-width:359px)': { width: 34, height: 34 } }}
    >
      {children}
    </Box>
  );
}

function FileName({ name }: { name: string }) {
  const characters = Array.from(name);
  const splitAt = characters.length > 38 ? characters.length - 13 : characters.length;
  return (
    <Box component="span" aria-hidden="true" sx={{ display: 'flex', minWidth: 0, fontWeight: 650, fontSize: '0.89rem' }}>
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre' }}>
        {characters.slice(0, splitAt).join('')}
      </Box>
      <Box component="span" sx={{ flexShrink: 0, whiteSpace: 'pre' }}>
        {characters.slice(splitAt).join('')}
      </Box>
    </Box>
  );
}

function ItemMenu({ target, onMenu }: { target: DocumentItem; onMenu: Props['onMenu'] }) {
  const kind = target.kind === 'folder' ? 'dossier' : 'fichier';
  return (
    <Tooltip title="Plus d’actions">
      <IconButton
        aria-label={'Actions du ' + kind + ' ' + target.item.name}
        aria-haspopup="menu"
        onClick={(event) => onMenu(target, event.currentTarget)}
        sx={actionStyle}
      >
        <MoreHorizIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function SectionTitle({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.9, mb: 1.15 }}>
      <Typography component="h3" id={id} sx={{ color: explorerColors.ink, fontSize: '0.93rem', fontWeight: 750 }}>
        {title}
      </Typography>
      <Box component="span" sx={{ minWidth: 23, px: 0.55, py: 0.16, borderRadius: 1.25, textAlign: 'center', bgcolor: '#e7eeee', color: explorerColors.muted, fontSize: '0.72rem', fontWeight: 700 }}>
        {count}
      </Box>
    </Box>
  );
}

export default function DocumentExplorerList({
  folders, files, searching, downloading, folderPath, onOpenFolder, onOpenFile, onDownload, onMenu,
}: Props) {
  if (!folders.length && !files.length) {
    return (
      <Box sx={{ p: 4, mt: 1, textAlign: 'center', border: '1px dashed ' + explorerColors.border, borderRadius: '14px', bgcolor: explorerColors.surface }}>
        <Box sx={{ mx: 'auto', mb: 1.5, width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: '14px', color: explorerColors.accent, bgcolor: explorerColors.accentSoft }}>
          {searching ? <SearchOffOutlinedIcon /> : <FolderOpenOutlinedIcon />}
        </Box>
        <Typography component="h3" sx={{ color: explorerColors.ink, fontWeight: 750, mb: 0.35 }}>
          {searching ? 'Aucun résultat' : 'Ce dossier est vide'}
        </Typography>
        <Typography variant="body2" sx={{ color: explorerColors.muted }}>
          {searching ? 'Essayez un autre mot-clé.' : 'Déposez un fichier ou créez un dossier.'}
        </Typography>
      </Box>
    );
  }

  return (
    <>
      {folders.length > 0 && (
        <Box component="section" aria-labelledby="doc-folders-heading" sx={{ mb: 3 }}>
          <SectionTitle id="doc-folders-heading" title="Dossiers" count={folders.length} />
          <Box
            component="ul"
            sx={{
              listStyle: 'none',
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
              gap: 1,
              p: 0,
              m: 0,
            }}
          >
            {folders.map((folder) => (
              <Box
                key={folder.id}
                component="li"
                sx={{ display: 'flex', alignItems: 'center', minWidth: 0, p: 0.375, border: '1px solid ' + explorerColors.border, borderRadius: '14px', bgcolor: explorerColors.surface }}
              >
                <ButtonBase onClick={() => onOpenFolder(folder.id)} aria-label={'Ouvrir le dossier ' + folder.name} title={folder.name} sx={itemButtonStyle}>
                  <IconTile color={explorerColors.folder} background={explorerColors.folderSoft}><FolderOutlinedIcon fontSize="small" /></IconTile>
                  <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                    <Typography component="span" noWrap display="block" sx={{ color: explorerColors.ink, fontWeight: 700, fontSize: '0.89rem' }}>
                      {folder.name}
                    </Typography>
                    <Typography component="span" variant="caption" noWrap display="block" sx={{ color: explorerColors.muted }}>
                      {folder.createdBy.name + ' · ' + dayFormatter.format(new Date(folder.updatedAt ?? folder.createdAt))}
                    </Typography>
                  </Box>
                </ButtonBase>
                <ItemMenu target={{ kind: 'folder', item: folder }} onMenu={onMenu} />
              </Box>
            ))}
          </Box>
        </Box>
      )}

      <Box component="section" aria-labelledby="doc-files-heading">
        <SectionTitle id="doc-files-heading" title="Fichiers" count={files.length} />
        {files.length === 0 ? (
          <Typography variant="body2" sx={{ color: explorerColors.muted }}>Aucun fichier dans ce dossier.</Typography>
        ) : (
          <Box sx={{ border: '1px solid ' + explorerColors.border, borderRadius: '14px', bgcolor: explorerColors.surface, overflow: 'hidden' }}>
            <Box
              aria-hidden="true"
              sx={{
                display: { xs: 'none', md: 'grid' },
                gridTemplateColumns: fileColumns,
                alignItems: 'center',
                px: 0.5,
                height: 36,
                bgcolor: '#edf3f3',
                color: explorerColors.muted,
                fontWeight: 700,
                fontSize: '0.72rem',
              }}
            >
              <Box sx={{ pl: 1.5 }}>Nom</Box>
              <Box>Dernière activité</Box>
              <Box>Taille</Box>
            </Box>
            <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
              {files.map((file) => {
                const lastDate = dayFormatter.format(new Date(file.updatedAt ?? file.createdAt));
                const isDownloading = downloading.has(file.id);
                return (
                  <Box
                    component="li"
                    key={file.id}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: 'minmax(0, 1fr) 82px', md: fileColumns },
                      '@media (max-width:359px)': { gridTemplateColumns: 'minmax(0, 1fr) 74px' },
                      alignItems: 'center',
                      minWidth: 0,
                      px: 0.5,
                      py: 0.4,
                      '& + &': { borderTop: '1px solid ' + explorerColors.border },
                    }}
                  >
                    <ButtonBase
                      onClick={() => onOpenFile(file)}
                      aria-label={'Détails de ' + file.name}
                      title={file.name}
                      sx={{ ...itemButtonStyle, color: explorerColors.ink, pl: 1 }}
                    >
                      <FileIcon mime={file.mime} />
                      <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                        <FileName name={file.name} />
                        <Typography component="span" variant="caption" noWrap display="block" sx={{ color: explorerColors.muted }}>
                          {searching ? folderPath(file.folderId) : file.user.name}
                          <Box component="span" sx={{ display: { xs: 'inline', md: 'none' } }}>
                            {' · ' + formatFileSize(file.size) + ' · ' + lastDate}
                          </Box>
                        </Typography>
                      </Box>
                    </ButtonBase>
                    <Typography component="span" variant="caption" sx={{ color: explorerColors.muted, display: { xs: 'none', md: 'block' } }}>{lastDate}</Typography>
                    <Typography component="span" variant="caption" sx={{ color: explorerColors.muted, display: { xs: 'none', md: 'block' } }}>{formatFileSize(file.size)}</Typography>
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                      <Tooltip title={isDownloading ? 'Téléchargement en cours' : 'Télécharger'}>
                        <span>
                          <IconButton
                            aria-label={'Télécharger ' + file.name}
                            disabled={isDownloading}
                            onClick={() => onDownload(file)}
                            sx={actionStyle}
                          >
                            {isDownloading ? <CircularProgress size={17} /> : <DownloadOutlinedIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <ItemMenu target={{ kind: 'file', item: file }} onMenu={onMenu} />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}
      </Box>
    </>
  );
}
