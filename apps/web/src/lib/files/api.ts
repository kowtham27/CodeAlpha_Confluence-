import {
  createFileResponseSchema,
  fileDownloadResponseSchema,
  fileListResponseSchema,
  fileResponseSchema,
  type CreateFileRequest,
  type CreateFileResponse,
  type FileSummary,
} from '@confluence/shared';
import { ApiError, request } from '../api';

export const createFile = (slug: string, body: CreateFileRequest): Promise<CreateFileResponse> =>
  request(`/rooms/${slug}/files`, {
    method: 'POST',
    body,
    schema: createFileResponseSchema,
    auth: true,
  });

export async function completeFile(slug: string, id: string): Promise<FileSummary> {
  const { file } = await request(`/rooms/${slug}/files/${id}/complete`, {
    method: 'POST',
    schema: fileResponseSchema,
    auth: true,
  });
  return file;
}

export async function listFiles(slug: string): Promise<FileSummary[]> {
  const { files } = await request(`/rooms/${slug}/files`, {
    schema: fileListResponseSchema,
    auth: true,
  });
  return files;
}

export async function downloadUrl(slug: string, id: string): Promise<string> {
  const { url } = await request(`/rooms/${slug}/files/${id}/download`, {
    schema: fileDownloadResponseSchema,
    auth: true,
  });
  return url;
}

export const deleteFile = (slug: string, id: string): Promise<void> =>
  request(`/rooms/${slug}/files/${id}`, { method: 'DELETE', auth: true });

/**
 * PUTs ciphertext straight to object storage. XHR rather than fetch because
 * fetch still cannot report upload progress.
 */
export function putToStorage(
  upload: CreateFileResponse,
  body: Blob,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.uploadUrl);
    for (const [name, value] of Object.entries(upload.uploadHeaders)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total || body.size);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, 'INTERNAL', 'The upload was refused by storage.'));
    xhr.onerror = () =>
      reject(new ApiError(0, 'NETWORK', 'The upload failed. Check your connection.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** GETs ciphertext from storage, reporting progress as it streams in. */
export async function fetchFromStorage(
  url: string,
  expectedSize: number,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(0, 'NETWORK', 'The download failed. Check your connection.');
  }
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, 'NOT_FOUND', 'That file is no longer available.');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(received, expectedSize);
  }
  return new Blob(parts);
}
