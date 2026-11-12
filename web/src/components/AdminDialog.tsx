import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminStats } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatUsd(v: number): string {
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent sx={{ py: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="h6">{value}</Typography>
        {sub && (
          <Typography variant="caption" color="text.secondary">
            {sub}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminDialog({ open, onClose }: Props) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await api.adminStats());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const maxDayTokens = stats ? Math.max(1, ...stats.llm.byDay.map((d) => d.tokens)) : 1;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        Administration — consommation LLM
        <Tooltip title="Rafraîchir">
          <IconButton size="small" onClick={() => void load()} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </DialogTitle>
      <DialogContent dividers>
        {loading && <LinearProgress sx={{ mb: 2 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {stats && (
          <>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
              <StatCard label="Appels LLM" value={String(stats.llm.calls)} sub={`${stats.llm.errors} erreur(s)`} />
              <StatCard
                label="Tokens consommés"
                value={stats.llm.totalTokens.toLocaleString('fr-FR')}
                sub={`${stats.llm.promptTokens.toLocaleString('fr-FR')} entrée · ${stats.llm.completionTokens.toLocaleString('fr-FR')} sortie`}
              />
              <StatCard
                label="Coût estimé"
                value={formatUsd(stats.llm.costUsd)}
                sub={stats.llm.priceKnown ? 'prix connus du modèle' : 'prix inconnus du modèle : définir LLM_INPUT/OUTPUT_PRICE_PER_1M'}
              />
              <StatCard label="Messages" value={String(stats.messages)} />
              <StatCard label="Membres" value={`${stats.users.online} en ligne / ${stats.users.total}`} />
              <StatCard
                label="Documents"
                value={String(stats.files.count)}
                sub={`${(stats.files.bytes / (1024 * 1024)).toFixed(1)} Mo stockés`}
              />
            </Box>

            <Typography variant="subtitle1" sx={{ mt: 3, mb: 1 }}>
              Activité LLM — 30 derniers jours
            </Typography>
            {stats.llm.byDay.length === 0 && <Typography variant="body2">Aucune consommation enregistrée.</Typography>}
            {stats.llm.byDay
              .slice()
              .reverse()
              .map((d) => (
                <Box key={d.day} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="caption" sx={{ width: 90 }}>
                    {d.day}
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={(d.tokens / maxDayTokens) * 100}
                    sx={{ flex: 1, height: 8, borderRadius: 4 }}
                  />
                  <Typography variant="caption" sx={{ width: 150 }}>
                    {d.tokens.toLocaleString('fr-FR')} tok · {formatUsd(d.costUsd)}
                  </Typography>
                </Box>
              ))}

            <Typography variant="subtitle1" sx={{ mt: 3, mb: 1 }}>
              Par commande
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Commande</TableCell>
                  <TableCell align="right">Appels</TableCell>
                  <TableCell align="right">Tokens</TableCell>
                  <TableCell align="right">Coût</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stats.llm.byCommand.map((c) => (
                  <TableRow key={c.command}>
                    <TableCell>/{c.command}</TableCell>
                    <TableCell align="right">{c.calls}</TableCell>
                    <TableCell align="right">{c.tokens.toLocaleString('fr-FR')}</TableCell>
                    <TableCell align="right">{formatUsd(c.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="subtitle1" sx={{ mt: 3, mb: 1 }}>
              Par modèle
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Modèle</TableCell>
                  <TableCell align="right">Appels</TableCell>
                  <TableCell align="right">Tokens</TableCell>
                  <TableCell align="right">Coût</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stats.llm.byModel.map((m) => (
                  <TableRow key={m.model}>
                    <TableCell>{m.model}</TableCell>
                    <TableCell align="right">{m.calls}</TableCell>
                    <TableCell align="right">{m.tokens.toLocaleString('fr-FR')}</TableCell>
                    <TableCell align="right">{formatUsd(m.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Fermer</Button>
      </DialogActions>
    </Dialog>
  );
}
