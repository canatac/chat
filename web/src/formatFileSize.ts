const sizeFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return sizeFormatter.format(bytes) + ' o';
  if (bytes < 1024 * 1024) return sizeFormatter.format(bytes / 1024) + ' Ko';
  if (bytes < 1024 * 1024 * 1024) return sizeFormatter.format(bytes / (1024 * 1024)) + ' Mo';
  return sizeFormatter.format(bytes / (1024 * 1024 * 1024)) + ' Go';
}
