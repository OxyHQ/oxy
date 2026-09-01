import { BadRequestError } from './error';

const BLOCKED_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/x-executable',
  'application/x-powershell',
]);

const BLOCKED_EXTENSIONS = new Set([
  'app', 'bat', 'cmd', 'com', 'dmg', 'exe', 'hta', 'jar', 'js', 'jse', 'msi',
  'ps1', 'scr', 'sh', 'vbe', 'vbs', 'wsf', 'wsh',
]);

/** Reject attachments that are executable by common desktop clients. Inbox
 * still stores and serves ordinary documents; this is a delivery guard, not a
 * claim that file metadata is a malware verdict. */
export function assertSafeOutboundAttachment(name: string, contentType: string): void {
  const extension = name.trim().toLowerCase().split('.').pop() ?? '';
  if (BLOCKED_EXTENSIONS.has(extension) || BLOCKED_MIME_TYPES.has(contentType.toLowerCase())) {
    throw new BadRequestError('Executable attachments cannot be sent by Inbox');
  }
}
