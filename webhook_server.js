#!/usr/bin/env node

const express = require('express');
const app = express();
app.use(express.json());

/**
 * Webhook endpoint for Zapier integration
 * Receives new lead form submissions from Zapier
 */
app.post('/webhook/new-lead', async (req, res) => {
  console.log(new Date().toISOString() + ' [WEBHOOK] Zapier triggered new lead');
  res.status(200).json({ status: 'received' });
  
  try {
    const { subject, from, body } = req.body;
    if (subject && subject.toLowerCase().includes('new submission from')) {
      console.log('[WEBHOOK] Processing lead from Zapier: ' + from);
      // TODO: Call processLeadFromWebhook({ subject, from, body });
    }
  } catch (err) {
    console.error('[WEBHOOK] Error processing lead:', err.message);
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
  console.log('[WEBHOOK] Server live on port ' + PORT);
  console.log('[WEBHOOK] Health check: GET /health');
  console.log('[WEBHOOK] Lead webhook: POST /webhook/new-lead');
});
