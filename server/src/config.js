require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 4000,
  env: process.env.NODE_ENV || 'development',
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/ota-updates',
  s3: {
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || 'auto',
    bucket: process.env.S3_BUCKET || 'ota-bundles',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  },
  admin: {
    user: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
  },
  maxBundleSizeMb: parseInt(process.env.MAX_BUNDLE_SIZE_MB, 10) || 200,
};

function validate() {
  const errs = [];
  if (!config.s3.bucket) errs.push('S3_BUCKET is required');
  if (!config.s3.accessKeyId) errs.push('S3_ACCESS_KEY_ID is required');
  if (!config.s3.secretAccessKey) errs.push('S3_SECRET_ACCESS_KEY is required');
  if (!config.s3.publicBaseUrl) errs.push('S3_PUBLIC_BASE_URL is required');
  if (errs.length) {
    console.error('[config] missing env:', errs.join(', '));
    if (config.env === 'production') process.exit(1);
  }
}

config.validate = validate;
module.exports = config;
