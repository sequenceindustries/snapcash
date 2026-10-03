// Applicant documents: Railway bucket (S3-compatible) in production, local disk in development.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';

const s3cfg = config.s3;
const useS3 = !!s3cfg.bucket;

const s3 = useS3 ? new S3Client({
  region: s3cfg.region,
  endpoint: s3cfg.endpoint || undefined,
  forcePathStyle: !!s3cfg.endpoint,
  credentials: s3cfg.accessKeyId ? { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey } : undefined,
}) : null;

function localPath(key) {
  const root = path.resolve(config.localUploadDir);
  const p = path.resolve(root, key);
  if (!p.startsWith(root + path.sep)) throw new Error('bad key');
  return p;
}

export async function putObject(key, buffer, contentType) {
  if (useS3) {
    await s3.send(new PutObjectCommand({ Bucket: s3cfg.bucket, Key: key, Body: buffer, ContentType: contentType }));
    return;
  }
  const p = localPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
}

// Returns a readable stream of the object.
export async function getObjectStream(key) {
  if (useS3) {
    const r = await s3.send(new GetObjectCommand({ Bucket: s3cfg.bucket, Key: key }));
    return r.Body;
  }
  return createReadStream(localPath(key));
}

export async function deleteObject(key) {
  if (useS3) {
    await s3.send(new DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: key }));
    return;
  }
  await fs.rm(localPath(key), { force: true });
}

export const storageMode = useS3 ? 'bucket' : 'local-disk';
