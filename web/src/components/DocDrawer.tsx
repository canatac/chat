import DownloadIcon from '@mui/icons-material/Download';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import SearchIcon from '@mui/icons-material/Search';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Avatar,
  Box,
  Button,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FileItem } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export default function DocDrawer({ open, onClose }: Props) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (q: string) => {
    try {
      const r = await api.files(q, undefined, 100);
      setFiles(r.files);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    }
  }, []);

  useEffect(() => {
    if (open) void load(query);
  }, [open, load, query]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      await api.uploadFile(f, '', false);
      await load(query);
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

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 440 } } }}
    >
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
        <Typography variant="h6">Espace documentaire</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Rechercher un document…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(query);
            }}
          />
          <IconButton color="primary" onClick={() => void load(query)}>
            <SearchIcon />
          </IconButton>
        </Box>
        <Button
          variant="outlined"
          startIcon={<UploadFileIcon />}
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? 'Envoi…' : 'Déposer un document'}
        </Button>
        <input hidden type="file" ref={fileRef} onChange={onPick} />
        {error && <Typography color="error" variant="caption">{error}</Typography>}
        <List sx={{ overflowY: 'auto', flex: 1 }}>
          {files.map((f) => (
            <ListItem
              key={f.id}
              secondaryAction={
                <IconButton edge="end" onClick={() => void download(f)}>
                  <DownloadIcon />
                </IconButton>
              }
            >
              <ListItemAvatar>
                <Avatar>
                  <InsertDriveFileIcon />
                </Avatar>
              </ListItemAvatar>
              <ListItemText
                primary={f.name}
                secondary={`${formatSize(f.size)} · ${f.user.name} · ${new Date(f.createdAt).toLocaleDateString('fr-FR')}`}
              />
            </ListItem>
          ))}
          {files.length === 0 && (
            <ListItem>
              <ListItemText primary="Aucun document pour le moment" />
            </ListItem>
          )}
        </List>
        <Typography variant="caption" color="text.secondary">
          Les documents déposés alimentent aussi les commandes /ask et /solve (RAG).
        </Typography>
      </Box>
    </Drawer>
  );
}
