'use strict';
const { execFileSync } = require('node:child_process');

function isPrivateIdentity(email) {
  return /^[^@\s]+@users\.noreply\.github\.com$/i.test(email) || email === 'noreply@github.com';
}

const values = process.argv.includes('--identity')
  ? ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map(name => execFileSync('git', ['var', name], { encoding: 'utf8' }).match(/<([^<>]+)>/)?.[1] || '')
  : execFileSync('git', ['log', '-1', '--format=%ae%x00%ce'], { encoding: 'utf8' }).trim().split('\0');
if (values.length !== 2 || !values.every(isPrivateIdentity)) {
  console.error('Commit privacy check failed: use a GitHub noreply identity for both author and committer. Addresses are intentionally not printed.');
  process.exitCode = 1;
} else console.log('Commit author and committer use private noreply identities.');
