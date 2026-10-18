import fs from 'node:fs/promises';

/** A completed notarytool command is not itself proof of Apple's acceptance. */
export async function notarizeExecutable({ executable, profile, keychain, run, remove = file => fs.rm(file, { force: true }) }) {
  const zip = `${executable}.zip`;
  try {
    await run('ditto', ['-c', '-k', '--keepParent', executable, zip]);
    const result = await run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, ...(keychain ? ['--keychain', keychain] : []), '--wait', '--output-format', 'json'], { maxBuffer: 8 * 1024 * 1024 });
    let submission;
    try { submission = JSON.parse(result.stdout); }
    catch { throw new Error('Apple notarization did not return valid JSON; the executable is not approved for distribution'); }
    if (submission?.status !== 'Accepted') throw new Error(`Apple notarization was not accepted (${submission?.status || 'missing status'}${submission?.id ? `; submission ${submission.id}` : ''}); inspect the notarization log before distributing this executable`);
    return { status: 'Accepted', submissionId: submission.id || null };
  } finally { await remove(zip); }
}
