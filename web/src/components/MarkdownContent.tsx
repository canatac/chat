import { Box, Link } from '@mui/material';
import { memo, type ComponentPropsWithoutRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatColors } from '../theme';

function MarkdownLink({ href, children, ...props }: ComponentPropsWithoutRef<'a'>) {
  if (href?.startsWith('#')) return <Link {...props} href={href}>{children}</Link>;
  let url: URL;
  try {
    url = new URL(href ?? '', window.location.href);
  } catch {
    return <>{children}</>;
  }
  if (!href || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return <>{children}</>;
  return <Link {...props} href={url.href} target="_blank" rel="noopener noreferrer">{children}</Link>;
}

const components: Components = {
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  // Les images distantes restent des liens pour éviter un chargement automatique vers un tiers.
  img: ({ src, alt }) => <MarkdownLink href={src}>{alt || 'Voir l’image'}</MarkdownLink>,
  pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} aria-label="Bloc de code" />,
  table: ({ node: _node, ...props }) => (
    <Box role="region" aria-label="Tableau" tabIndex={0} sx={{ maxWidth: '100%', overflowX: 'auto', my: '0.75em' }}>
      <table {...props} />
    </Box>
  ),
};

const remarkPlugins = [remarkGfm];

export default memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Box sx={{
      minWidth: 0, maxWidth: '100%', fontSize: '0.91rem', lineHeight: 1.57, overflowWrap: 'anywhere',
      '& p': { mt: 0, mb: '0.75em', whiteSpace: 'pre-wrap' },
      '& h1, & h2, & h3, & h4, & h5, & h6': { mt: '1.2em', mb: '0.5em', fontWeight: 750, lineHeight: 1.35 },
      '& h1': { fontSize: '1.3em' },
      '& h2': { fontSize: '1.2em' },
      '& h3': { fontSize: '1.1em' },
      '& h4, & h5, & h6': { fontSize: '1em' },
      '& ul, & ol': { my: '0.65em', pl: '1.6em' },
      '& li + li': { mt: '0.3em' },
      '& li > p': { mb: '0.3em' },
      '& li > ul, & li > ol': { my: '0.3em' },
      '& blockquote': { mx: 0, my: '0.75em', pl: '1em', borderLeft: '3px solid ' + chatColors.border, color: chatColors.muted },
      '& a': { color: chatColors.accent, textUnderlineOffset: '0.15em' },
      '& code': { fontFamily: 'Consolas, "Liberation Mono", monospace', fontSize: '0.9em', bgcolor: '#142f330d', px: '0.3em', py: '0.1em', borderRadius: '4px' },
      '& pre': { my: '0.75em', p: 1.1, maxWidth: '100%', overflowX: 'auto', bgcolor: '#142f330d', border: '1px solid ' + chatColors.border, borderRadius: '7px' },
      '& pre code': { display: 'block', p: 0, bgcolor: 'transparent', whiteSpace: 'pre', overflowWrap: 'normal' },
      '& table': { borderCollapse: 'collapse', minWidth: '100%', width: 'max-content' },
      '& th, & td': { p: '0.5em 0.75em', minWidth: '8em', maxWidth: '24em', border: '1px solid ' + chatColors.border, verticalAlign: 'top' },
      '& th': { fontWeight: 700, bgcolor: '#142f330d' },
      '& input[type="checkbox"]': { mr: '0.4em' },
      '& hr': { my: '1em', border: 0, borderTop: '1px solid ' + chatColors.border },
      '& pre:focus-visible, & [role="region"]:focus-visible': { outline: '2px solid ' + chatColors.accent, outlineOffset: 2 },
      '& > :first-child': { mt: 0 },
      '& > :last-child': { mb: 0 },
    }}>
      <Markdown remarkPlugins={remarkPlugins} components={components} skipHtml>{content}</Markdown>
    </Box>
  );
});
