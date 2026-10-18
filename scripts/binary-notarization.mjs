import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

function parseJson(stdout, context) {
  try { return JSON.parse(stdout); }
  catch { throw new Error(`Apple notarization did not return valid JSON (${context}); the artifact is not approved for distribution`); }
}

/** Validate the actual code hashes Apple accepted, not merely a completed job.
 * Apple's log paths can differ from local paths; CDHashes identify the code. */
export function validateNotarizationLog(log, { submissionId, archiveSha256, tickets }) {
  if (log?.status !== 'Accepted' || log?.jobId !== submissionId) throw new Error('Apple notarization log does not confirm the accepted submission');
  if (log.sha256?.toLowerCase() !== archiveSha256) throw new Error('Apple notarization log archive checksum does not match the submitted bytes');
  if (!Array.isArray(log.ticketContents) || !Array.isArray(tickets) || !tickets.length) throw new Error('Apple notarization ticket coverage is missing');
  if (log.issues != null && !Array.isArray(log.issues)) throw new Error('Apple notarization log has unreadable issues');
  if (log.issues?.some(issue => issue.severity === 'error')) throw new Error('Apple notarization log contains errors');
  const accepted = new Set(log.ticketContents.filter(item => typeof item.cdhash === 'string').map(item => item.cdhash.toLowerCase()));
  for (const ticket of tickets) {
    if (!/^[a-f0-9]{40}$/.test(ticket.cdhash) || !accepted.has(ticket.cdhash)) throw new Error(`Apple notarization ticket is missing native code: ${ticket.path} (${ticket.arch})`);
  }
  return { status: 'Accepted', submissionId, archiveSha256, ticketCount: log.ticketContents.length, verifiedCodeCount: tickets.length, issues: log.issues || [] };
}

/** A custom extracting executable needs two submissions: its unpacked payload,
 * then its final signed launcher. Both must cover every native CodeDirectory. */
async function notarizeTarget({ target, profile, keychain, tickets, run, report = console.log,
  hashFile = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex'),
  remove = file => fs.rm(file, { force: true }) }) {
  if (!tickets?.length) throw new Error('Notarization requires an inventory of signed native code');
  const zip = `${target}.zip`;
  const credentials = ['--keychain-profile', profile, ...(keychain ? ['--keychain', keychain] : [])];
  try {
    await run('ditto', ['-c', '-k', '--keepParent', target, zip]);
    const archiveSha256 = await hashFile(zip);
    const submitted = parseJson((await run('xcrun', ['notarytool', 'submit', zip, ...credentials, '--output-format', 'json'], { maxBuffer: 8 * 1024 * 1024 })).stdout, 'submission');
    if (typeof submitted?.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(submitted.id)) throw new Error('Apple notarization did not return a submission ID');
    // Emit the non-secret ID before waiting, so a delayed first submission can
    // be inspected or resumed instead of being silently submitted again.
    report(`Apple notarization submitted: ${submitted.id} (${tickets.length} native code slices; archive SHA-256 ${archiveSha256})`);
    const submission = parseJson((await run('xcrun', ['notarytool', 'wait', submitted.id, ...credentials, '--output-format', 'json'], { maxBuffer: 8 * 1024 * 1024 })).stdout, 'completion');
    if (submission?.status !== 'Accepted' || submission.id !== submitted.id) throw new Error(`Apple notarization was not accepted (${submission?.status || 'missing status'}; submission ${submitted.id}); inspect the notarization log before distributing this artifact`);
    const log = parseJson((await run('xcrun', ['notarytool', 'log', submitted.id, ...credentials], { maxBuffer: 16 * 1024 * 1024 })).stdout, 'log');
    const result = validateNotarizationLog(log, { submissionId: submitted.id, archiveSha256, tickets });
    for (const issue of result.issues) report(`Apple notarization ${issue.severity || 'issue'}: ${issue.message || JSON.stringify(issue)}`);
    return result;
  } finally { await remove(zip); }
}

export const notarizeExecutable = ({ executable, ...options }) => notarizeTarget({ target: executable, ...options });
export const notarizePayload = ({ root, ...options }) => notarizeTarget({ target: root, ...options });
