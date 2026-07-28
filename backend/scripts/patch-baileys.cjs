/**
 * WAMR Baileys Patch — Selective Receipt Filtering
 *
 * Patches @whiskeysockets/baileys messages-recv.js to support a
 * `shouldSendReceipt(msg)` config callback. When the callback returns
 * false, the delivery receipt is skipped (protocol ACK is still sent)
 * and the messages.upsert event is NOT emitted.
 *
 * This allows WAMR to only send delivery receipts for messages it
 * actually cares about (/request + active sessions), preserving
 * WhatsApp phone notifications for everything else.
 *
 * Run: node scripts/patch-baileys.js
 * Also called from postinstall hook.
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(
  __dirname,
  '../../node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js'
);

if (!fs.existsSync(filePath)) {
  console.log('Baileys not installed yet, skipping patch');
  process.exit(0);
}

let content = fs.readFileSync(filePath, 'utf8');

// Check if already patched
if (content.includes('_wamrShouldProcess')) {
  console.log('Baileys already patched for WAMR receipt filtering');
  process.exit(0);
}

// Back up original
fs.writeFileSync(filePath + '.bak', content, 'utf8');

let patchCount = 0;

// ─── PATCH 1: Add _wamrShouldProcess variable after await decrypt() ───
// This variable tracks whether we should send a receipt and emit the event.
// It's declared at the top of the processingMutex callback so it's accessible
// to both the receipt logic and the upsertMessage call.
const oldDecrypt = 'await decrypt();';
const newDecrypt = `await decrypt();
                    // [WAMR PATCH] Track whether to send receipt for this message
                    let _wamrShouldProcess = true;`;

if (content.includes(oldDecrypt)) {
  content = content.replace(oldDecrypt, newDecrypt);
  patchCount++;
  console.log('  [1/4] Added _wamrShouldProcess variable');
} else {
  console.error('  [1/4] FAILED: Could not find "await decrypt();"');
}

// ─── PATCH 2: Add shouldSendReceipt check before receipt logic ───
// After decryption succeeds, check the callback to decide whether to
// send a delivery receipt.
const oldIsNewsletter =
  'const isNewsletter = isJidNewsletter(msg.key.remoteJid);\n                    if (!isNewsletter) {';
const newIsNewsletter =
  `const isNewsletter = isJidNewsletter(msg.key.remoteJid);
                    // [WAMR PATCH] Check shouldSendReceipt callback after decryption
                    _wamrShouldProcess = config.shouldSendReceipt ? await config.shouldSendReceipt(msg) : true;
                    if (!isNewsletter && _wamrShouldProcess) {`;

if (content.includes(oldIsNewsletter)) {
  content = content.replace(oldIsNewsletter, newIsNewsletter);
  patchCount++;
  console.log('  [2/4] Added shouldSendReceipt check');
} else {
  console.error('  [2/4] FAILED: Could not find isNewsletter + if block');
}

// ─── PATCH 3: Add else clause for non-matching messages ───
// Instead of just newsletter vs normal, we now have three branches:
// 1. Normal message that matches filter → send receipt (existing logic)
// 2. Newsletter → sendMessageAck only (existing logic)
// 3. Non-matching message → sendMessageAck only, NO receipt (new)
const oldElseNewsletter = `else {
                        acked = true;
                        await sendMessageAck(node);
                        logger.debug({ key: msg.key }, 'processed newsletter message without receipts');
                    }`;
const newElseNewsletter = `else if (isNewsletter) {
                        acked = true;
                        await sendMessageAck(node);
                        logger.debug({ key: msg.key }, 'processed newsletter message without receipts');
                    }
                    else {
                        // [WAMR PATCH] Non-matching message — ACK without delivery receipt
                        acked = true;
                        await sendMessageAck(node);
                        logger.debug({ key: msg.key }, 'WAMR: skipped receipt for non-matching message');
                    }`;

if (content.includes(oldElseNewsletter)) {
  content = content.replace(oldElseNewsletter, newElseNewsletter);
  patchCount++;
  console.log('  [3/4] Added else clause for non-matching messages');
} else {
  console.error('  [3/4] FAILED: Could not find newsletter else block');
}

// ─── PATCH 4: Make upsertMessage conditional ───
// Only emit the messages.upsert event for messages that matched the filter.
// Non-matching messages are silently ignored at the Baileys level.
const oldUpsert = 'await upsertMessage(msg, node.attrs.offline ? \'append\' : \'notify\');';
const newUpsert = `// [WAMR PATCH] Only emit upsert for matching messages
                if (_wamrShouldProcess !== false) {
                    await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
                }`;

if (content.includes(oldUpsert)) {
  content = content.replace(oldUpsert, newUpsert);
  patchCount++;
  console.log('  [4/4] Made upsertMessage conditional');
} else {
  console.error('  [4/4] FAILED: Could not find upsertMessage call');
}

if (patchCount === 4) {
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`\nBaileys patched successfully (${patchCount}/4 patches applied)`);
} else {
  // Restore backup
  fs.copyFileSync(filePath + '.bak', filePath);
  console.error(`\nPatch FAILED (${patchCount}/4). Original file restored.`);
  process.exit(1);
}
