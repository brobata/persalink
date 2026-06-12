/**
 * @file File upload helper
 * @description Uploads one or more files to the PersaLink server's /api/upload
 *   endpoint in a single multipart request. The server (busboy) streams each
 *   file to disk and returns the server-side `~`-relative paths in upload
 *   order, ready to be pasted into the terminal.
 */

interface UploadOpts {
  serverUrl: string;
  authToken: string | null;
}

interface UploadResponse {
  paths?: string[];
  path?: string; // single-file back-compat field
  partial?: boolean;
}

/**
 * Upload every file in `files` in one request. Returns the uploaded paths in
 * order. The server drops any file that exceeds the per-file size cap, so the
 * returned list may be shorter than the input (reflected by `response.partial`).
 */
export async function uploadFiles(
  files: FileList | File[],
  { serverUrl, authToken }: UploadOpts,
): Promise<string[]> {
  const list = Array.from(files);
  if (list.length === 0) return [];

  const hostOnly = serverUrl.trim().replace(/^(wss?|https?):\/\//i, '');
  const scheme = window.location.protocol === 'https:' ? 'https://' : 'http://';
  const baseUrl = `${scheme}${hostOnly}`;

  const form = new FormData();
  for (const file of list) form.append('file', file);

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);

  const result = (await res.json()) as UploadResponse;
  if (Array.isArray(result.paths)) return result.paths;
  // Back-compat with an older single-path server response.
  return result.path ? [result.path] : [];
}
