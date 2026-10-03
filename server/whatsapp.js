// One-time codes over WhatsApp (Infobip authentication template), with optional SMS fallback.
import { config } from './config.js';

const ib = config.infobip;

export function otpDeliveryConfigured() {
  return !!(ib.baseUrl && ib.apiKey && ((ib.whatsappSender && ib.whatsappTemplate) || ib.smsSender));
}

async function infobip(path, body) {
  const r = await fetch(ib.baseUrl + path, {
    method: 'POST',
    headers: { Authorization: `App ${ib.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const text = data?.requestError?.serviceException?.text || data?.errorMessage || `HTTP ${r.status}`;
    throw new Error(`Infobip: ${text}`);
  }
  return data;
}

// phone is E.164 (+27...). Returns { channel }.
export async function sendOtp(phone, code) {
  const to = phone.replace(/^\+/, '');

  if (!otpDeliveryConfigured()) {
    if (config.devLogOtp) {
      console.log(`[otp] DEV — code for ${phone}: ${code}`);
      return { channel: 'dev-log' };
    }
    throw new Error('WhatsApp delivery is not configured');
  }

  if (ib.whatsappSender && ib.whatsappTemplate) {
    try {
      const templateData = { body: { placeholders: [code] } };
      if (ib.whatsappCopyButton) templateData.buttons = [{ type: 'URL', parameter: code }];
      await infobip('/whatsapp/1/message/template', {
        messages: [{
          from: ib.whatsappSender.replace(/^\+/, ''),
          to,
          content: { templateName: ib.whatsappTemplate, templateData, language: ib.whatsappLanguage },
        }],
      });
      return { channel: 'whatsapp' };
    } catch (err) {
      if (!ib.smsSender) throw err;
      console.error('[otp] WhatsApp failed, falling back to SMS:', err.message);
    }
  }

  await infobip('/sms/2/text/advanced', {
    messages: [{
      from: ib.smsSender,
      destinations: [{ to }],
      text: `Your snapcash code is ${code}. It expires in 5 minutes. Never share it with anyone, including snapcash staff.`,
    }],
  });
  return { channel: 'sms' };
}
