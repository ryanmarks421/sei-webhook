#!/usr/bin/env node

const express = require('express');
const app = express();
app.use(express.json());

const WEBHOOK_SECRET = 'sei-mortgage-zapier-2026';

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
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond to Zapier immediately so it does not time out
  res.status(200).json({ status: 'received', timestamp: new Date().toISOString() });

  console.log(new Date().toISOString() + ' [WEBHOOK] Zapier fired — processing lead');

  try {
    const { subject, from, body } = req.body;

    // Confirm it is a lead email
    if (!subject || !subject.toLowerCase().includes('new submission from')) {
      console.log(new Date().toISOString() + ' [WEBHOOK] Not a lead email — ignoring');
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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    service: 'SEI Mortgage Webhook Server'
  });
});

/**
 * Start server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(new Date().toISOString() + ' [WEBHOOK] Server live on port ' + PORT);
  console.log(new Date().toISOString() + ' [WEBHOOK] Webhook endpoint: POST /webhook/new-lead');
  console.log(new Date().toISOString() + ' [WEBHOOK] Health check: GET /health');
});
