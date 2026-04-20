const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const config = require('../config');

const client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint || undefined,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
  forcePathStyle: config.s3.forcePathStyle,
});

async function uploadBuffer(key, buffer, contentType = 'application/octet-stream') {
  const upload = new Upload({
    client,
    params: {
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
  });
  return upload.done();
}

async function deleteKey(key) {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey') return true;
    throw err;
  }
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function publicUrl(key) {
  return `${config.s3.publicBaseUrl}/${key}`;
}

module.exports = { client, uploadBuffer, deleteKey, exists, publicUrl };
