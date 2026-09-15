import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Object storage for encrypted files. Everything stored here is ciphertext:
 * the browser encrypts before uploading and decrypts after downloading.
 *
 * Two clients, same credentials: `internal` makes the API's own calls (which
 * inside Docker must reach the storage service by its compose name), and
 * `presigner` only signs URLs, with the endpoint the browser can reach. A
 * presigned URL's signature covers its host, so it must be signed for the
 * host it will actually be sent to.
 */
const common = {
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  // MinIO and most self-hosted S3 stores need path-style bucket URLs.
  forcePathStyle: true,
};

const internal = new S3Client({ ...common, endpoint: env.S3_ENDPOINT });
const presigner = new S3Client({ ...common, endpoint: env.S3_PUBLIC_ENDPOINT });

const Bucket = env.S3_BUCKET;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** Local convenience: create the bucket on first boot. Production pre-provisions it. */
export async function ensureBucket(): Promise<void> {
  try {
    await internal.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await internal.send(new CreateBucketCommand({ Bucket }));
    logger.info({ bucket: Bucket }, 'created storage bucket');
  }
}

/** For the health check: can we reach the bucket? */
export async function probeStorage(): Promise<void> {
  await internal.send(new HeadBucketCommand({ Bucket }));
}

/**
 * A presigned PUT bound to an exact size and content type. Both are signed
 * headers, so the browser cannot upload more bytes than the API agreed to,
 * or relabel the object: a mismatch fails at the storage layer.
 */
export async function presignUpload(
  key: string,
  sizeBytes: number,
): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { 'Content-Type': 'application/octet-stream' };
  const url = await getSignedUrl(
    presigner,
    new PutObjectCommand({
      Bucket,
      Key: key,
      ContentLength: sizeBytes,
      ContentType: headers['Content-Type'],
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-length', 'content-type']),
    },
  );
  return { url, headers };
}

/**
 * A short-lived GET that always downloads as an opaque attachment (spec:
 * Content-Disposition: attachment), from the storage origin rather than the
 * app's. Even if a stored object were somehow HTML, it could never run with
 * the app's origin or cookies; and it is ciphertext in any case.
 */
export function presignDownload(key: string): Promise<string> {
  return getSignedUrl(
    presigner,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: 'attachment',
      ResponseContentType: 'application/octet-stream',
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

/** Size of a stored object, or null if it does not exist. */
export async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/** Raw object bytes. Tests use it to prove what is stored is unreadable. */
export async function readObject(key: string): Promise<Uint8Array> {
  const result = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
  if (!result.Body) return new Uint8Array();
  return result.Body.transformToByteArray();
}
