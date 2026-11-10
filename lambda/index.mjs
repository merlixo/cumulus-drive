// Lambda entry point: wires pure handler to AWS SDK v3
// (provided by nodejs22.x runtime, never imported by local tests).
import {
  S3Client, PutObjectCommand, GetObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHandler } from './handler.mjs';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET;
const URL_TTL_SECONDS = 3600;

const manifestKey = (login, key) => `projects/${login}/${key}/manifest.json`;

// Without s3:ListBucket on the exact path, S3 responds with 403 (not 404) to a
// GetObject/HeadObject on a missing object; since the role has GetObject rights
// on these exact patterns, a 403 here can only mean "missing".
const isAbsence = (err) => {
  const status = err.$metadata?.httpStatusCode;
  return status === 404 || status === 403;
};

async function readText(objectKey) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey }));
  return res.Body.transformToString();
}

export const handler = createHandler({
  async loadAccounts() {
    let raw;
    try {
      raw = await readText('auth/accounts.json');
    } catch (err) {
      if (isAbsence(err)) return {}; // registry not created yet: no accounts
      throw err;
    }
    return JSON.parse(raw); // corrupted registry → error propagated (502)
  },

  async getManifest(login, key) {
    let raw;
    try {
      raw = await readText(manifestKey(login, key));
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    return JSON.parse(raw);
  },

  async putManifest(login, key, body) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey(login, key),
      Body: body,
      ContentType: 'application/json',
      IfNoneMatch: '*',
    }));
  },

  // Overwrites an existing manifest (readOnly toggle); create uses putManifest.
  async writeManifest(login, key, body) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: manifestKey(login, key),
      Body: body,
      ContentType: 'application/json',
    }));
  },

  // Everything here is a *signed* header: the client must send each one
  // verbatim or S3 rejects the PUT (403), so none of it can be tampered with.
  //   ContentLength   — exact size announced to the Lambda, so storage quotas
  //                     cannot be bypassed by under-declaring size.
  //   ContentType     — normalized by the Lambda (uploadHeaders), so an upload
  //                     can never be typed as a document on our own origin.
  //   ContentDisposition — 'inline' for gallery media so a photo or video opens
  //                     normally, 'attachment' for everything else; also
  //                     decided by uploadHeaders, never by the client.
  //   IfNoneMatch: '*' — an upload may create a key, never overwrite one, so
  //                     an existing file's stored headers can't be rewritten.
  presignPut(objectKey, contentType, contentLength, contentDisposition) {
    return getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
        ContentType: contentType,
        ContentLength: contentLength,
        ContentDisposition: contentDisposition,
        IfNoneMatch: '*',
      }),
      { expiresIn: URL_TTL_SECONDS },
    );
  },

  async listObjectsUnder(prefix) {
    const objects = [];
    let token;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
      }));
      for (const item of res.Contents ?? []) objects.push({ key: item.Key, size: item.Size ?? 0 });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return objects;
  },

  getObjectText(objectKey) {
    return readText(objectKey);
  },

  async deleteObjects(objectKeys) {
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: objectKeys.map((Key) => ({ Key })), Quiet: true },
    }));
  },
});
