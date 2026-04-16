#!/usr/bin/env node

/**
 * SEI Mortgage Lead Processor
 * Orchestrates all 9 steps in correct order
 * 
 * Step 1: Monitor inbox for new lead emails
 * Step 2: Parse email to extract 8 form fields
 * Step 3: Validate lead data
 * Step 4: Create Bonzo contact
 * Step 5: Apply Bonzo tags
 * Step 6: Add to SEI New Lead pipeline
 * Step 7: Enroll in SEI New Lead Nurture campaign
 * Step 8: Generate personalized reply email
 * Step 9: Send reply + confirmation notifications
 */

const imapMonitor = require('./imap_monitor');
const emailParser = require('./email_parser');
const bonzoIntegrator = require('./bonzo_integrator');
const groqEmailGenerator = require('./groq_email_generator');
const smtpSend = require('./smtp_send');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../.openclaw/workspace/logs/sei_lead_processor.log');

/**
 * Log processing step
 */
function logStep(step, status, details) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] STEP ${step}: ${status} | ${JSON.stringify(details)}\n`;
  
  try {
    fs.appendFileSync(LOG_FILE, logEntry, 'utf8');
  } catch (err) {
    console.error('Logging error:', err.message);
  }
  
  console.log(logEntry.trim());
}

/**
 * Process a single lead through all 9 steps
 */
async function processLead(email, processingStartTime) {
  try {
    logStep(1, 'MONITOR', { uid: email.uid, subject: email.subject });

    // STEP 2: Parse email
    logStep(2, 'START', { uid: email.uid });
    const leadData = emailParser.extractLeadData(email.body);
    if (!leadData) {
      logStep(2, 'FAILED', { reason: 'Could not parse email body' });
      return { success: false, step: 2, reason: 'Parse failed' };
    }
    logStep(2, 'SUCCESS', leadData);

    // STEP 3: Validate lead data
    logStep(3, 'START', { fields: Object.keys(leadData).length });
    const isTestSubmission = leadData.name && leadData.name.toLowerCase().includes('miles test');
    if (isTestSubmission) {
      logStep(3, 'TEST_DETECTED', { name: leadData.name, action: 'process_but_do_not_create_real_lead' });
    } else {
      if (!leadData.email || !leadData.name || !leadData.phone) {
        logStep(3, 'VALIDATION_FAILED', { missing: 'required_fields' });
        return { success: false, step: 3, reason: 'Validation failed' };
      }
      logStep(3, 'SUCCESS', { validated: true });
    }

    // STEP 4-7: Bonzo integration (skip for test submissions)
    if (!isTestSubmission) {
      logStep(4, 'START', { email: leadData.email });
      const contact = await bonzoIntegrator.createContact(leadData);
      if (!contact || !contact.id) {
        logStep(4, 'FAILED', { reason: 'Contact creation failed' });
        return { success: false, step: 4, reason: 'Bonzo contact creation failed' };
      }
      logStep(4, 'SUCCESS', { contactId: contact.id });

      logStep(5, 'START', { contactId: contact.id });
      await bonzoIntegrator.applyTags(contact.id, leadData);
      logStep(5, 'SUCCESS', { contactId: contact.id });

      logStep(6, 'START', { contactId: contact.id });
      await bonzoIntegrator.addToPipeline(contact.id, 'SEI New Lead');
      logStep(6, 'SUCCESS', { contactId: contact.id, pipeline: 'SEI New Lead' });

      logStep(7, 'START', { contactId: contact.id });
      await bonzoIntegrator.enrollInCampaign(contact.id, 'SEI New Lead Nurture');
      logStep(7, 'SUCCESS', { contactId: contact.id, campaign: 'SEI New Lead Nurture' });
    } else {
      logStep(4, 'SKIPPED', { reason: 'Test submission - no real Bonzo lead created' });
      logStep(5, 'SKIPPED', { reason: 'Test submission' });
      logStep(6, 'SKIPPED', { reason: 'Test submission' });
      logStep(7, 'SKIPPED', { reason: 'Test submission' });
    }

    // STEP 8: Generate personalized reply using Groq (free tier)
    logStep(8, 'START', { email: leadData.email, model: 'groq-llama3.3-70b' });
    const replyEmail = await groqEmailGenerator.generateWelcomeEmailWithGroq(leadData);
    if (!replyEmail || !replyEmail.subject) {
      logStep(8, 'FAILED', { reason: 'Groq email generation failed' });
      return { success: false, step: 8, reason: 'Email generation failed' };
    }
    logStep(8, 'SUCCESS', { subject: replyEmail.subject, model: 'groq', cost: 'FREE' });

    // STEP 9: Send reply + confirmations (5 minute rule starts now)
    logStep(9, 'START', { recipient: leadData.email });
    const replyResult = await smtpSend.sendPersonalizedReply(
      leadData.email,
      replyEmail.subject,
      replyEmail.html
    );
    if (!replyResult.success) {
      logStep(9, 'FAILED', { reason: 'SMTP send failed' });
      return { success: false, step: 9, reason: 'Send failed' };
    }
    logStep(9, 'REPLY_SENT', { recipient: leadData.email, messageId: replyResult.messageId });

    // Send confirmation notifications
    const adminEmails = ['hello@seimortgage.com', 'ryanmarks421@gmail.com'];
    const processingTimeMs = Date.now() - processingStartTime;
    const confirmations = await smtpSend.sendConfirmationNotification(
      adminEmails,
      leadData.name,
      leadData.email,
      processingTimeMs
    );
    logStep(9, 'CONFIRMATIONS_SENT', { 
      recipients: adminEmails.length,
      processingTimeMs: processingTimeMs
    });

    return {
      success: true,
      leadName: leadData.name,
      leadEmail: leadData.email,
      processingTimeMs: processingTimeMs,
      isTestSubmission: isTestSubmission,
      replySubject: replyEmail.subject,
      replyPreview: replyEmail.html.substring(0, 200)
    };
  } catch (err) {
    logStep(9, 'ERROR', { error: err.message });
    return {
      success: false,
      error: err.message,
      processingTimeMs: Date.now() - processingStartTime
    };
  }
}

/**
 * Main processor loop
 */
async function runProcessor() {
  try {
    // STEP 1: Monitor inbox
    const monitorResult = await imapMonitor.checkInboxForNewLeads();

    if (monitorResult.status === 'no_new') {
      console.log(`[${new Date().toISOString()}] No new leads`);
      return { status: 'no_new' };
    }

    if (monitorResult.status === 'error') {
      console.error(`[${new Date().toISOString()}] Monitor error:`, monitorResult.error);
      return { status: 'error', error: monitorResult.error };
    }

    // Process each email
    const results = [];
    for (const email of monitorResult.emails) {
      const processingStartTime = Date.now();
      const result = await processLead(email, processingStartTime);
      results.push(result);
    }

    return {
      status: 'success',
      leadsProcessed: results.length,
      results: results
    };
  } catch (err) {
    console.error('Processor error:', err.message);
    return { status: 'error', error: err.message };
  }
}

// Main execution
if (require.main === module) {
  runProcessor().then(result => {
    console.log('\n=== PROCESSOR RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'error' ? 1 : 0);
  }).catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

/**
 * Full lead processing for webhook integration
 * Takes parsed lead data and runs through all 9 steps
 */
async function runFullLeadProcessing(leadData) {
  try {
    const processingStartTime = Date.now();
    
    // Create a mock email object that processLead expects
    const mockEmail = {
      uid: 'webhook-' + Date.now(),
      subject: 'Webhook: ' + leadData.full_name,
      from: leadData.email,
      body: JSON.stringify(leadData)
    };
    
    const result = await processLead(mockEmail, processingStartTime);
    return result;
  } catch (err) {
    console.error('[WEBHOOK] Full processing error:', err.message);
    throw err;
  }
}

module.exports = {
  processLead,
  runProcessor,
  runFullLeadProcessing,
  logStep
};
