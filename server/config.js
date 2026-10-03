// All configuration comes from environment variables (set them in Railway → Variables).
const env = process.env;

function bool(v) { return /^(1|true|yes)$/i.test(String(v || '')); }

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env.PORT) || 3000,
  // Public address of the site, e.g. https://snapcash.money (no trailing slash).
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/+$/, ''),
  databaseUrl: env.DATABASE_URL,
  // Long random string used to sign short-lived cookies (Google sign-in state).
  sessionSecret: env.SESSION_SECRET || (isProd ? null : 'dev-only-not-secret'),
  sessionDays: Number(env.SESSION_DAYS) || 7,
  sessionIdleHours: Number(env.SESSION_IDLE_HOURS) || 12,

  ownerAdminEmail: (env.OWNER_ADMIN_EMAIL || '').trim().toLowerCase() || null,
  adminNotifyEmail: (env.ADMIN_NOTIFY_EMAIL || '').trim() || null,

  google: {
    clientId: env.GOOGLE_CLIENT_ID || null,
    clientSecret: env.GOOGLE_CLIENT_SECRET || null,
  },

  resend: {
    apiKey: env.RESEND_API_KEY || null,
    from: env.EMAIL_FROM || 'snapcash <applications@snapcash.money>',
    replyTo: env.EMAIL_REPLY_TO || 'hello@snapcash.money',
  },

  infobip: {
    baseUrl: (env.INFOBIP_BASE_URL || '').replace(/\/+$/, '') || null, // e.g. https://xxxxx.api.infobip.com
    apiKey: env.INFOBIP_API_KEY || null,
    whatsappSender: env.INFOBIP_WHATSAPP_SENDER || null,             // your WhatsApp number, digits only
    whatsappTemplate: env.INFOBIP_WHATSAPP_TEMPLATE || null,         // approved authentication template name
    whatsappLanguage: env.INFOBIP_WHATSAPP_LANGUAGE || 'en',
    whatsappCopyButton: env.INFOBIP_WHATSAPP_COPY_BUTTON === undefined ? true : bool(env.INFOBIP_WHATSAPP_COPY_BUTTON),
    smsSender: env.INFOBIP_SMS_SENDER || null,                       // optional SMS fallback
  },

  // Railway bucket (S3-compatible). Without it, development stores files on local disk.
  s3: {
    bucket: env.S3_BUCKET || null,
    endpoint: env.S3_ENDPOINT || null,
    region: env.S3_REGION || 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID || null,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || null,
  },
  localUploadDir: env.LOCAL_UPLOAD_DIR || '.data/uploads',

  // Development only: print one-time codes to the server log when Infobip isn't set up.
  devLogOtp: !isProd && !bool(env.DISABLE_DEV_OTP_LOG),
};

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (isProd) {
    if (!/^https:\/\//.test(config.appUrl)) missing.push('APP_URL (must be https)');
    if (!config.s3.bucket) missing.push('S3_BUCKET (and the other S3_* variables)');
  }
  if (missing.length) {
    throw new Error('Missing required configuration: ' + missing.join(', '));
  }
  const warnings = [];
  if (!config.google.clientId || !config.google.clientSecret) warnings.push('Google sign-in disabled (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set)');
  if (!config.resend.apiKey) warnings.push('Emails will not be sent (RESEND_API_KEY not set)');
  if (!config.infobip.apiKey) warnings.push('WhatsApp codes will not be sent (INFOBIP_* not set)');
  return warnings;
}
