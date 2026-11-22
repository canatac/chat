import AttachFileOutlinedIcon from '@mui/icons-material/AttachFileOutlined';
import DoneAllRoundedIcon from '@mui/icons-material/DoneAllRounded';
import DoneRoundedIcon from '@mui/icons-material/DoneRounded';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Avatar, Box, Button, ButtonBase, CircularProgress, Link, Tooltip, Typography } from '@mui/material';
import { Fragment, useState, type ReactNode } from 'react';
import { api, saveFile } from '../api';
import { chatColors } from '../theme';
import type { Mention, Message, MessageFile, MessageReceipt, User } from '../types';
import MarkdownContent from './MarkdownContent';
import DocumentAnalysis from './DocumentAnalysis';

interface Props {
  message: Message;
  sender: User;
  own: boolean;
  groupStart: boolean;
  highlighted: boolean;
  receipt?: MessageReceipt;
  onUseFile?: (file: MessageFile, command: 'ask' | 'resume') => void;
}

const hours = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const assistantColor = '#604785';
const assistantBackground = '#f3eef9';
const urlPattern = /(https?:\/\/[^\s<>"«»]+)/gi;

function linkText(content: string) {
  return content.split(urlPattern).map((part, index) => {
    if (index % 2 === 0) return part;
    const href = part.replace(/[.,!?;]+$/, '');
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return part;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return part;

    return (
      <span key={index}>
        <Link
          href={url.href}
          target="_blank"
          rel="noopener noreferrer"
          title={href}
          underline="always"
          sx={{ color: chatColors.accent, textUnderlineOffset: '0.15em', fontWeight: 650 }}
        >
          {href.length <= 80 ? href : url.hostname + ' / …'}
        </Link>
        {part.slice(href.length)}
      </span>
    );
  });
}

function MessageText({ content, mentions }: { content: string; mentions: Mention[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, userId } of mentions) {
    if (start < cursor || end <= start || end > content.length) continue;
    parts.push(<Fragment key={'text-' + cursor}>{linkText(content.slice(cursor, start))}</Fragment>);
    parts.push(
      <Box key={'mention-' + start} component="strong" data-mention={userId === null ? 'room' : 'person'} sx={{
        fontWeight: 750, color: chatColors.accent, bgcolor: '#dbeee8', borderRadius: '4px', px: 0.35, boxDecorationBreak: 'clone',
      }}>
        {content.slice(start, end)}
      </Box>,
    );
    cursor = end;
  }
  parts.push(<Fragment key={'text-' + cursor}>{linkText(content.slice(cursor))}</Fragment>);
  return (
    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.57, fontSize: '0.91rem' }}>
      {parts}
    </Typography>
  );
}

function FileDownload({ file, onUseFile }: { file: MessageFile; onUseFile?: Props['onUseFile'] }) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const document = !/^(audio|video)\//.test(file.mime);

  const download = async () => {
    if (status === 'busy') return;
    setStatus('busy');
    try {
      await saveFile(file);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  return (
    <Box sx={{ minWidth: 0 }}>
      <Tooltip title={file.name} enterDelay={500}>
        <span>
          <ButtonBase
            disabled={status === 'busy'}
            onClick={() => void download()}
            aria-label={'Télécharger ' + file.name}
            sx={{
              minWidth: 0, width: '100%', justifyContent: 'flex-start', gap: 0.85, textAlign: 'left',
              px: 1, py: 0.75, borderRadius: '8px', minHeight: 39,
              border: '1px solid ' + chatColors.border, bgcolor: chatColors.surface, color: chatColors.ink,
              '&:hover': { bgcolor: chatColors.background },
              '&.Mui-focusVisible': { outline: '2px solid ' + chatColors.accent },
            }}
          >
            <AttachFileOutlinedIcon sx={{ flexShrink: 0, color: chatColors.accent, fontSize: 17 }} />
            <Typography component="span" noWrap sx={{ minWidth: 0, flex: 1, fontSize: '0.83rem', fontWeight: 650 }}>
              {file.name}
            </Typography>
            {status === 'busy'
              ? <CircularProgress size={16} sx={{ flexShrink: 0 }} />
              : <DownloadOutlinedIcon sx={{ flexShrink: 0, color: chatColors.muted, fontSize: 18 }} />}
          </ButtonBase>
        </span>
      </Tooltip>
      {document && <DocumentAnalysis analysis={file.analysis} details />}
      {document && onUseFile && <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.3 }}>
        <Button size="small" aria-label={'Résumer ' + file.name} onClick={() => onUseFile(file, 'resume')}>Résumer</Button>
        <Button size="small" aria-label={'Analyser ' + file.name} onClick={() => onUseFile(file, 'ask')}>Analyser / questionner</Button>
        {file.analysis?.status === 'blocked' && file.analysis.issue?.retryable !== false && <Button size="small" disabled={retrying} onClick={() => {
          setRetrying(true); setRetryError(null);
          void api.analyzeFile(file.id).catch((error) => setRetryError(error instanceof Error ? error.message : 'Analyse impossible.')).finally(() => setRetrying(false));
        }}>Relancer l’extraction</Button>}
      </Box>}
      {retryError && <Typography role="alert" variant="caption" color="error">{retryError}</Typography>}
      {status === 'error' && (
        <Typography role="alert" variant="caption" color="error" sx={{ mt: 0.35, display: 'block' }}>
          Téléchargement impossible. Réessaie en cliquant sur le fichier.
        </Typography>
      )}
    </Box>
  );
}

function ReceiptStatus({ receipt }: { receipt?: MessageReceipt }) {
  const received = receipt?.received ?? 0;
  const read = receipt?.read ?? 0;
  let label = 'Envoyé';
  if (received > read) label = `Reçu par ${received}`;
  if (read) label = received > read ? `${label} · Lu par ${read}` : `Lu par ${read}`;
  const Icon = received ? DoneAllRoundedIcon : DoneRoundedIcon;
  return (
    <Typography variant="caption" component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.45, px: 0.35, color: read ? chatColors.accent : chatColors.muted }}>
      <Icon sx={{ fontSize: 15, flexShrink: 0 }} aria-hidden="true" />
      {label}
    </Typography>
  );
}

export default function MessageRow({ message, sender, own, groupStart, highlighted, receipt, onUseFile }: Props) {
  const time = hours.format(new Date(message.createdAt));
  const isBot = message.user.isBot;
  const author = own ? 'Vous' : isBot ? 'Assistant' : sender.name;
  const files = message.files ?? [];
  const attachmentOnly = files.length === 1 && message.content === '📎 ' + files[0].name;
  const bubbleColor = own ? chatColors.accentSoft : isBot ? assistantBackground : chatColors.surface;

  return (
    <Box
      component="article"
      aria-label={author + ' à ' + time}
      sx={{
        display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start', alignItems: 'flex-start', gap: 1,
        mt: groupStart ? 1.75 : 0.6, color: chatColors.ink,
      }}
    >
      {!own && (
        <Box sx={{ flexShrink: 0, width: { xs: 29, sm: 34 } }}>
          {groupStart && (
            <Avatar
              aria-hidden="true"
              src={sender.avatar ?? undefined}
              sx={{
                width: { xs: 29, sm: 34 }, height: { xs: 29, sm: 34 }, borderRadius: '9px',
                fontWeight: 750, fontSize: '0.78rem',
                bgcolor: isBot ? assistantBackground : '#e1eeee',
                color: isBot ? assistantColor : chatColors.accent,
              }}
            >
              {isBot ? <SmartToyOutlinedIcon sx={{ fontSize: 18 }} /> : sender.name.slice(0, 1).toUpperCase()}
            </Avatar>
          )}
        </Box>
      )}
      <Box
        sx={{
          minWidth: 0,
          maxWidth: { xs: own ? '89%' : 'calc(100% - 37px)', sm: 'min(79%, 690px)' },
          display: 'flex',
          flexDirection: 'column',
          alignItems: own ? 'flex-end' : 'flex-start',
        }}
      >
        {groupStart && (
          <Box sx={{ display: 'flex', gap: 0.75, minWidth: 0, maxWidth: '100%', alignItems: 'baseline', mb: 0.35, px: 0.25 }}>
            <Typography noWrap component="span" sx={{ color: isBot ? assistantColor : chatColors.ink, fontSize: '0.78rem', fontWeight: 720 }}>
              {author}
            </Typography>
            <Typography component="time" dateTime={message.createdAt} variant="caption" sx={{ flexShrink: 0, color: chatColors.muted }}>
              {time}
            </Typography>
          </Box>
        )}
        <Box
          data-message-id={message.id}
          data-receivable={own ? undefined : ''}
          tabIndex={highlighted ? -1 : undefined}
          title={groupStart ? undefined : time}
          sx={{
            minWidth: 0, maxWidth: '100%', px: 1.45, py: 0.95, bgcolor: bubbleColor,
            border: '1px solid ' + (isBot ? '#e9e1f4' : chatColors.border),
            borderRadius: '13px',
            borderTopLeftRadius: !own && groupStart ? '5px' : undefined,
            borderTopRightRadius: own && groupStart ? '5px' : undefined,
            outline: highlighted ? '2px solid #378578' : undefined,
            outlineOffset: 2,
          }}
        >
          {!attachmentOnly && (isBot
            ? <MarkdownContent content={message.content} />
            : <MessageText content={message.content} mentions={message.mentions ?? []} />)}
          {files.length > 0 && (
            <Box sx={{ display: 'grid', minWidth: 0, gap: 0.7, mt: attachmentOnly ? 0 : 0.8 }}>
              {files.map((file) => <FileDownload key={file.id} file={file} onUseFile={onUseFile} />)}
            </Box>
          )}
        </Box>
        {own && <ReceiptStatus receipt={receipt} />}
      </Box>
    </Box>
  );
}
