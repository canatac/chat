import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HistoryIcon from '@mui/icons-material/History';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import { Box, IconButton, List, ListItem, ListItemButton, Tooltip, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { chatColors } from '../theme';
import type { Folder } from '../types';
import { documentDropAttributes, documentDropStyle } from '../useDocumentDrag';

export type DocumentPlace = number | null | 'recent';

interface Props {
  foldersByParent: ReadonlyMap<number | null, Folder[]>;
  currentPath: Folder[];
  active: DocumentPlace | undefined;
  onNavigate: (place: DocumentPlace) => void;
}

const placeStyle = {
  width: '100%', minWidth: 0, minHeight: 39, gap: 1, py: 0.6, px: 1, borderRadius: '8px',
  color: chatColors.ink, textAlign: 'left',
  '&.Mui-selected': { bgcolor: '#dceee8', color: chatColors.accent },
  '&.Mui-selected:hover': { bgcolor: '#d3e9e2' },
  '&.Mui-focusVisible': { outline: '2px solid ' + chatColors.accent, outlineOffset: -2 },
};

export default function DocumentPlaces({ foldersByParent, currentPath, active, onNavigate }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const lastPath = useRef('');

  useEffect(() => {
    const key = currentPath.map(({ id }) => id).join('/');
    if (key === lastPath.current) return;
    lastPath.current = key;
    setExpanded((previous) => new Set([...previous, ...currentPath.map(({ id }) => id)]));
  }, [currentPath]);

  function toggleFolder(id: number) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pending = (foldersByParent.get(null) ?? []).slice().reverse().map((folder) => ({ folder, depth: 0 }));
  const visible: typeof pending = [];
  while (pending.length) {
    const row = pending.pop()!;
    visible.push(row);
    if (!expanded.has(row.folder.id)) continue;
    const children = foldersByParent.get(row.folder.id) ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push({ folder: children[index], depth: row.depth + 1 });
  }

  function renderFolders() {
    return visible.map(({ folder, depth }) => {
      const hasChildren = foldersByParent.has(folder.id);
      const isOpen = expanded.has(folder.id);
      const isCurrent = active === folder.id;
      const toggleLabel = (isOpen ? 'Replier ' : 'Déplier ') + folder.name;
      return (
        <Box component="li" key={folder.id}>
          <Box {...documentDropAttributes({ kind: 'folder', id: folder.id })} sx={{ display: 'flex', alignItems: 'center', minWidth: 0, pl: Math.min(depth, 5) * 1.5, borderRadius: '8px', ...documentDropStyle }}>
            {hasChildren ? (
              <Tooltip disableInteractive title={toggleLabel}>
                <IconButton
                  aria-label={toggleLabel}
                  aria-expanded={isOpen}
                  onClick={() => toggleFolder(folder.id)}
                  sx={{ width: 28, height: 34, flexShrink: 0, color: chatColors.muted }}
                >
                  {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            ) : <Box aria-hidden="true" sx={{ width: 28, flexShrink: 0 }} />}
            <ListItemButton
              component="button"
              selected={isCurrent}
              aria-current={isCurrent ? 'page' : undefined}
              aria-label={'Aller au dossier ' + folder.name}
              title={folder.name}
              onClick={() => onNavigate(folder.id)}
              sx={placeStyle}
            >
              {isCurrent ? <FolderOpenOutlinedIcon fontSize="small" /> : <FolderOutlinedIcon fontSize="small" />}
              <Typography component="span" noWrap sx={{ fontSize: '0.83rem', fontWeight: isCurrent ? 750 : 550 }}>{folder.name}</Typography>
            </ListItemButton>
          </Box>
        </Box>
      );
    });
  }

  return (
    <Box component="nav" aria-label="Emplacements des documents" sx={{ px: 1.25, pt: 1.65, pb: 2 }}>
      <Typography component="h3" sx={{ px: 1.1, pb: 0.8, color: chatColors.muted, fontSize: '0.76rem', fontWeight: 750 }}>Emplacements</Typography>
      <List disablePadding sx={{ display: 'grid', gap: 0.25 }}>
        <ListItem disablePadding>
          <ListItemButton component="button" {...documentDropAttributes({ kind: 'folder', id: null })} selected={active === null} aria-current={active === null ? 'page' : undefined} onClick={() => onNavigate(null)} sx={{ ...placeStyle, ...documentDropStyle }}>
            <HomeOutlinedIcon fontSize="small" />
            <Typography component="span" sx={{ fontSize: '0.86rem', fontWeight: 700 }}>Racine</Typography>
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton component="button" selected={active === 'recent'} aria-current={active === 'recent' ? 'page' : undefined} onClick={() => onNavigate('recent')} sx={placeStyle}>
            <HistoryIcon fontSize="small" />
            <Typography component="span" sx={{ fontSize: '0.86rem', fontWeight: 700 }}>Récents</Typography>
          </ListItemButton>
        </ListItem>
      </List>
      {foldersByParent.has(null) && (
        <Box sx={{ mt: 2.1, pt: 1.45, borderTop: '1px solid ' + chatColors.border }}>
          <Typography component="h3" sx={{ px: 1.1, pb: 0.65, color: chatColors.muted, fontSize: '0.76rem', fontWeight: 750 }}>Dossiers</Typography>
          <List disablePadding>{renderFolders()}</List>
        </Box>
      )}
    </Box>
  );
}
