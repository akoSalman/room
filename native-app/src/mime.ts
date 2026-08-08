// Mime-type inference from a filename/URI extension.
//
// Files arriving through Android's share sheet very often carry no usable
// mimeType (content:// URIs frequently report nothing, or the catch-all
// application/octet-stream). Without a real type every shared file was sent as
// a generic 'file', so music arrived without a player and PDFs/documents lost
// their icon. Falling back to the extension restores the right bubble.
const BY_EXT: Record<string, string> = {
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  wma: 'audio/x-ms-wma', amr: 'audio/amr', mid: 'audio/midi', midi: 'audio/midi',
  // video
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', webm: 'video/webm', '3gp': 'video/3gpp', wmv: 'video/x-ms-wmv',
  // images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
  svg: 'image/svg+xml', tiff: 'image/tiff', tif: 'image/tiff',
  // documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', rtf: 'application/rtf', csv: 'text/csv',
  md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html',
  epub: 'application/epub+zip',
  // archives
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  apk: 'application/vnd.android.package-archive',
};

export function extOf(nameOrUri: string): string {
  // Strip any query/fragment, then take the trailing extension.
  const clean = String(nameOrUri || '').split(/[?#]/)[0];
  const base = clean.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// Best-effort mime for a file. A caller-supplied type always wins unless it's
// the meaningless octet-stream catch-all.
export function guessMime(nameOrUri: string, supplied?: string | null): string {
  if (supplied && supplied !== 'application/octet-stream' && supplied.includes('/')) {
    return supplied;
  }
  return BY_EXT[extOf(nameOrUri)] || supplied || 'application/octet-stream';
}

// The message type the server/UI uses for a given file.
export function messageTypeFor(mime: string, nameOrUri = ''): 'image' | 'video' | 'music' | 'file' {
  const m = guessMime(nameOrUri, mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'music';
  return 'file';
}

// A friendly icon for non-media files, so documents don't all look identical.
export function fileIcon(nameOrUri: string, mime?: string | null): string {
  const m = guessMime(nameOrUri, mime);
  const e = extOf(nameOrUri);
  if (m === 'application/pdf') return '📕';
  if (m.startsWith('audio/')) return '🎵';
  if (m.startsWith('video/')) return '🎥';
  if (m.startsWith('image/')) return '🖼';
  if (/word|document/.test(m) || e === 'doc' || e === 'docx') return '📘';
  if (/sheet|excel|csv/.test(m) || e === 'csv') return '📗';
  if (/presentation|powerpoint/.test(m)) return '📙';
  if (/zip|rar|7z|tar|gzip|compressed/.test(m)) return '🗜';
  if (m.startsWith('text/') || /json|xml/.test(m)) return '📝';
  if (e === 'apk') return '📦';
  return '📄';
}
