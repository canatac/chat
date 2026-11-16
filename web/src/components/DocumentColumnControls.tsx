import FilterAltIcon from '@mui/icons-material/FilterAlt';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import { Box, Button, IconButton, Popover, Stack, TableSortLabel, TextField, Tooltip, Typography } from '@mui/material';
import { useId, useState, type FormEvent } from 'react';
import { chatColors } from '../theme';
import type { FileColumn, FileFilters, FileSort } from '../types';

interface Props {
  desktopColumns: string;
  sort: FileSort;
  filters: FileFilters;
  onSort: (sort: FileSort) => void;
  onFilter: (filters: FileFilters) => void;
}

const columns = [
  { column: 'name', label: 'Nom', firstDirection: 'asc' },
  { column: 'date', label: 'Date', firstDirection: 'desc' },
  { column: 'size', label: 'Taille', firstDirection: 'asc' },
] as const;

export default function DocumentColumnControls({ desktopColumns, sort, filters, onSort, onFilter }: Props) {
  const [editor, setEditor] = useState<{ column: FileColumn; anchor: HTMLButtonElement } | null>(null);
  const [draft, setDraft] = useState({ name: '', from: '', to: '', minimum: '', maximum: '' });
  const [error, setError] = useState('');
  const popoverId = useId();
  const active = {
    name: Boolean(filters.name),
    date: Boolean(filters.dateFrom || filters.dateTo),
    size: filters.minSizeKiB !== undefined || filters.maxSizeKiB !== undefined,
  };
  const editing = columns.find(({ column }) => column === editor?.column);
  const filterTitle = editing ? 'Filtrer par ' + editing.label.toLowerCase() : '';

  function openFilter(column: FileColumn, anchor: HTMLButtonElement) {
    setDraft({
      name: filters.name ?? '',
      from: filters.dateFrom ?? '',
      to: filters.dateTo ?? '',
      minimum: String(filters.minSizeKiB ?? ''),
      maximum: String(filters.maxSizeKiB ?? ''),
    });
    setError('');
    setEditor({ column, anchor });
  }

  function applyFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (editor.column === 'name') {
      onFilter({ ...filters, name: draft.name.trim() || undefined });
    } else if (editor.column === 'date') {
      if (draft.from && draft.to && draft.from > draft.to) {
        setError('La date de fin doit être égale ou postérieure à la date de début.');
        return;
      }
      onFilter({ ...filters, dateFrom: draft.from || undefined, dateTo: draft.to || undefined });
    } else {
      const minSizeKiB = draft.minimum === '' ? undefined : Number(draft.minimum);
      const maxSizeKiB = draft.maximum === '' ? undefined : Number(draft.maximum);
      if ([minSizeKiB, maxSizeKiB].some((value) => value !== undefined && (
        !Number.isFinite(value) || value < 0 || value * 1024 > Number.MAX_SAFE_INTEGER
      ))) {
        setError('Saisissez des tailles valides, positives ou nulles.');
        return;
      }
      if (minSizeKiB !== undefined && maxSizeKiB !== undefined && minSizeKiB > maxSizeKiB) {
        setError('La taille maximale doit être supérieure ou égale au minimum.');
        return;
      }
      onFilter({ ...filters, minSizeKiB, maxSizeKiB });
    }
    setEditor(null);
  }

  function clearFilter() {
    if (editor?.column === 'name') onFilter({ ...filters, name: undefined });
    if (editor?.column === 'date') onFilter({ ...filters, dateFrom: undefined, dateTo: undefined });
    if (editor?.column === 'size') onFilter({ ...filters, minSizeKiB: undefined, maxSizeKiB: undefined });
    setEditor(null);
  }

  return (
    <>
      <Box
        role="group"
        aria-label="Tri et filtres des fichiers"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(3, minmax(0, 1fr))', md: desktopColumns },
          alignItems: 'center',
          px: 0.5,
          bgcolor: '#edf3f3',
          color: chatColors.muted,
        }}
      >
        {columns.map(({ column, label, firstDirection }) => {
          const isSorted = sort.column === column;
          const direction = isSorted ? sort.direction : firstDirection;
          const sortLabel = 'Trier par ' + label.toLowerCase();
          const filterLabel = 'Filtrer par ' + label.toLowerCase();
          return (
            <Box key={column} sx={{ display: 'flex', alignItems: 'center', minWidth: 0, pl: { xs: 0.5, md: column === 'name' ? 1 : 0 } }}>
              <Tooltip disableInteractive title={column === 'date' ? 'Date de dernière activité' : sortLabel}>
                <TableSortLabel
                  active={isSorted}
                  direction={direction}
                  aria-label={sortLabel + (isSorted ? ', ordre ' + (direction === 'asc' ? 'croissant' : 'décroissant') : '')}
                  onClick={() => onSort({ column, direction: isSorted ? (direction === 'asc' ? 'desc' : 'asc') : firstDirection })}
                  sx={{
                    minHeight: 40, color: 'inherit', fontWeight: 750, fontSize: '0.79rem',
                    '&.Mui-active, &.Mui-active .MuiTableSortLabel-icon': { color: chatColors.accent },
                    '& .MuiTableSortLabel-icon': { fontSize: 15, mx: 0.25 },
                    '&.Mui-focusVisible': { outline: '2px solid ' + chatColors.accent, borderRadius: '4px' },
                  }}
                >
                  {label}
                </TableSortLabel>
              </Tooltip>
              <Tooltip disableInteractive title={active[column] ? filterLabel + ' (actif)' : filterLabel}>
                <IconButton
                  aria-label={filterLabel + (active[column] ? ', filtre actif' : '')}
                  aria-haspopup="dialog"
                  aria-expanded={editor?.column === column}
                  aria-controls={editor?.column === column ? popoverId : undefined}
                  onClick={(event) => openFilter(column, event.currentTarget)}
                  sx={{ width: 36, height: 40, color: active[column] ? chatColors.accent : chatColors.muted }}
                >
                  {active[column] ? <FilterAltIcon sx={{ fontSize: 17 }} /> : <FilterAltOutlinedIcon sx={{ fontSize: 17 }} />}
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}
      </Box>

      <Popover
        open={editor !== null}
        anchorEl={editor?.anchor}
        onClose={() => setEditor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { id: popoverId, role: 'dialog', 'aria-label': filterTitle, sx: { p: 2, width: 290, maxWidth: 'calc(100vw - 32px)', borderRadius: '12px' } } }}
      >
        <Stack component="form" noValidate onSubmit={applyFilter} gap={1.5}>
          <Typography fontWeight={750}>{filterTitle}</Typography>
          {editing?.column === 'name' && (
            <TextField autoFocus size="small" label="Le nom contient" value={draft.name} slotProps={{ htmlInput: { maxLength: 100 } }} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          )}
          {editing?.column === 'date' && (
            <>
              <TextField autoFocus size="small" type="date" label="Du" value={draft.from} slotProps={{ inputLabel: { shrink: true } }} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
              <TextField size="small" type="date" label="Au" value={draft.to} slotProps={{ inputLabel: { shrink: true } }} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
            </>
          )}
          {editing?.column === 'size' && (
            <>
              <TextField autoFocus size="small" type="number" label="Minimum (Ko)" value={draft.minimum} slotProps={{ htmlInput: { min: 0, step: 'any' } }} onChange={(event) => setDraft({ ...draft, minimum: event.target.value })} />
              <TextField size="small" type="number" label="Maximum (Ko)" value={draft.maximum} slotProps={{ htmlInput: { min: 0, step: 'any' } }} onChange={(event) => setDraft({ ...draft, maximum: event.target.value })} />
            </>
          )}
          {error && <Typography role="alert" variant="body2" color="error">{error}</Typography>}
          <Stack direction="row" justifyContent="flex-end" gap={1}>
            {editing && active[editing.column] && <Button onClick={clearFilter} sx={{ textTransform: 'none' }}>Effacer</Button>}
            <Button variant="contained" type="submit" sx={{ bgcolor: chatColors.accent, textTransform: 'none' }}>Appliquer</Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}
