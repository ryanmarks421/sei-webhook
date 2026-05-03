#!/usr/bin/env node

const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = 'sei-mortgage-zapier-2026';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'sei-mortgage-telegram-2026';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8776763466:AAGl75TXJFlqM0Iwglcr5Q_wULOK19wRlcY';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8680190773';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const TELEGRAM_MODEL = process.env.MILES_TELEGRAM_MODEL || 'gpt-5.4-mini';
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://sei-webhook.onrender.com/webhook/telegram';
const MEMORY_PATH = path.join(process.cwd(), 'MEMORY.md');

let memoryContent = '';

const safeJsonParse = (text, context) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${context} returned invalid JSON: ${err.message}; body=${String(text).slice(0, 400)}`);
  }
};

const requestJson = ({ hostname, path: requestPath, method, headers, body, timeoutMs, label }) => {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: requestPath,
        method,
        headers: headers || {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: data });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${label} timed out after ${timeoutMs}ms`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
};

const loadMemory = () => {
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      memoryContent = fs.readFileSync(MEMORY_PATH, 'utf8');
      console.log(new Date().toISOString() + ' [WEBHOOK] MEMORY.md loaded (' + memoryContent.length + ' chars)');
    }
  } catch (err) {
    console.error(new Date().toISOString() + ' [WEBHOOK] Could not load MEMORY.md: ' + err.message);
    memoryContent = '';
  }
};

const sendTelegram = async (messageText) => {
  const body = JSON.stringify({ chat_id: CHAT_ID, text: messageText });
  const result = await requestJson({
    hostname: 'api.telegram.org',
    path: '/bot' + BOT_TOKEN + '/sendMessage',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body,
    timeoutMs: 15000,
    label: 'Telegram send'
  });

  const parsed = safeJsonParse(result.body, 'Telegram send');
  if (!parsed.ok) {
    throw new Error('Telegram API error: ' + (parsed.description || 'unknown error'));
  }

  return parsed;
};

const ensureTelegramWebhook = async () => {
  const body = JSON.stringify({
    url: TELEGRAM_WEBHOOK_URL,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: true,
    allowed_updates: ['message', 'edited_message']
  });

  const result = await requestJson({
    hostname: 'api.telegram.org',
    path: '/bot' + BOT_TOKEN + '/setWebhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body,
    timeoutMs: 15000,
    label: 'Telegram setWebhook'
  });

  const parsed = safeJsonParse(result.body, 'Telegram setWebhook');
  if (!parsed.ok) {
    throw new Error('Telegram setWebhook error: ' + (parsed.description || 'unknown error'));
  }

  console.log(new Date().toISOString() + ' [TELEGRAM] Webhook registered: ' + TELEGRAM_WEBHOOK_URL);
};

const askOpenAI = async (question) => {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const body = JSON.stringify({
    model: TELEGRAM_MODEL,
    max_completion_tokens: 500,
    messages: [
      {
        role: 'developer',
        content: 'You are Miles, Ryan Marks\' personal AI assistant. Keep replies concise for Telegram. Respond in plain text only. No markdown tables. No code fences.\n\n' + memoryContent
      },
      {
        role: 'user',
        content: question
      }
    ]
  });

  const result = await requestJson({
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_KEY,
      'Content-Length': Buffer.byteLength(body)
    },
    body,
    timeoutMs: 45000,
    label: 'OpenAI request'
  });

  const parsed = safeJsonParse(result.body, 'OpenAI');
  if (parsed.error) {
    throw new Error('OpenAI API error: ' + (parsed.error.message || 'unknown error'));
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI response did not include assistant content');
  }

  return content;
};

const handleTelegramMessage = async (message) => {
  const text = String(message?.text || '').trim();
  if (!text) {
    return;
  }

  console.log(new Date().toISOString() + ' [TELEGRAM] Inbound message: ' + text.slice(0, 200));

  if (text.toLowerCase() === 'status') {
    await sendTelegram('Miles Telegram webhook is live. Uptime: ' + Math.round(process.uptime()) + 's.');
    return;
  }

  const reply = await askOpenAI(text);
  await sendTelegram(reply);
};

/**
 * Sanitize email body to remove invalid UTF-16 surrogates and malformed encoding
 */
const sanitizeEmailBody = (body) => {
  if (!body) return '';
  let clean = body.replace(/[\uD800-\uDFFF]/g, '');
  clean = clean.replace(/=\r?\n/g, '');
  clean = clean.replace(/=([0-9A-Fa-f]{2})/g, (match, hex) =>
    String.fromCharCode(parseInt(hex, 16)));
  clean = clean.replace(/<[^>]*>/g, ' ');
  clean = clean.replace(/[^\x20-\x7E\n\r\t]/g, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean;
};

/**
 * Main webhook endpoint for Zapier integration
 * Receives new lead form submissions and processes through full pipeline
 */
app.post('/webhook/new-lead', async (req, res) => {
  // Verify secret header
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    console.log(new Date().toISOString() + ' [WEBHOOK] Unauthorized webhook attempt blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond to Zapier immediately so it does not time out
  res.status(200).json({ status: 'received', timestamp: new Date().toISOString() });

  console.log(new Date().toISOString() + ' [WEBHOOK] Zapier fired - processing lead');

  try {
    const { subject, from, body } = req.body;

    // Confirm it is a lead email
    if (!subject || !subject.toLowerCase().includes('new submission from')) {
      console.log(new Date().toISOString() + ' [WEBHOOK] Not a lead email - ignoring');
      return;
    }

    // Import lead processing modules
    const emailParser = require('./scripts/sei_lead_integration/email_parser');
    const { runFullLeadProcessing } = require('./scripts/sei_lead_integration/sei_lead_processor');

    // Parse the lead data from the email body
    console.log(new Date().toISOString() + ' [WEBHOOK] Parsing lead data from email body');
    const cleanBody = sanitizeEmailBody(body);
    const leadData = emailParser.extractLeadData(cleanBody);

    if (!leadData || !leadData.email || !leadData.full_name) {
      console.error(new Date().toISOString() + ' [WEBHOOK] Could not parse lead data from webhook');
      return;
    }

    console.log(new Date().toISOString() + ' [WEBHOOK] Lead parsed: ' + leadData.full_name + ' | ' + leadData.email);

    // Run the full 9 step processing pipeline
    const result = await runFullLeadProcessing(leadData);

    console.log(new Date().toISOString() + ' [WEBHOOK] Lead fully processed: ' + leadData.full_name);
    console.log(new Date().toISOString() + ' [WEBHOOK] Result: ' + JSON.stringify(result));

  } catch (error) {
    console.error(new Date().toISOString() + ' [WEBHOOK] Processing error:', error.message);
  }
});

/**
 * Telegram webhook endpoint
 */
app.post('/webhook/telegram', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== TELEGRAM_WEBHOOK_SECRET) {
    console.log(new Date().toISOString() + ' [TELEGRAM] Unauthorized webhook attempt blocked');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({ status: 'received', timestamp: new Date().toISOString() });

  try {
    const update = req.body || {};
    const message = update.message;
    if (!message || String(message.chat?.id) !== CHAT_ID) {
      return;
    }

    await handleTelegramMessage(message);
    console.log(new Date().toISOString() + ' [TELEGRAM] Message handled successfully');
  } catch (error) {
    console.error(new Date().toISOString() + ' [TELEGRAM] Processing error: ' + error.message);
    try {
      await sendTelegram('Sorry Ryan, hit an error: ' + error.message);
    } catch (sendErr) {
      console.error(new Date().toISOString() + ' [TELEGRAM] Error reply failed: ' + sendErr.message);
    }
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'SEI Mortgage Webhook Server'
  });
});

loadMemory();

/**
 * Start server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(new Date().toISOString() + ' [WEBHOOK] Server live on port ' + PORT);
  console.log(new Date().toISOString() + ' [WEBHOOK] Webhook endpoint: POST /webhook/new-lead');
  console.log(new Date().toISOString() + ' [TELEGRAM] Webhook endpoint: POST /webhook/telegram');
  console.log(new Date().toISOString() + ' [WEBHOOK] Health check: GET /health');
  ensureTelegramWebhook().catch((err) => {
    console.error(new Date().toISOString() + ' [TELEGRAM] Could not register webhook: ' + err.message);
  });
});
