const { execFileSync } = require('node:child_process');

const includeHistory = process.argv.includes('--history');

function gitLines(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPrivatePath(file) {
  const path = file.replaceAll('\\', '/');
  const lower = path.toLowerCase();

  if (/(^|\/)(?:node_modules|backup|backups|private-migration|uploads)(?:\/|$)/.test(lower)) return true;
  if (lower.includes('/public/uploads/')) return true;
  if (/(^|\/)(?:certs|ssl)(?:\/|$)/.test(lower)) return true;
  if (/(?:^|\/)\.env(?:\.|$)/.test(lower) && !lower.endsWith('.example')) return true;
  if (/(?:^|\/)(?:env\.env(?:\.txt)?|original\.env|beforehttps\.env)$/.test(lower)) return true;
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(lower)) return true;
  if (/\.(?:key|pem|p12|pfx)$/.test(lower)) return true;
  if (/\.(?:log|err|out)$/.test(lower)) return true;
  if (/(?:^|\/)students[^/]*\.csv$/.test(lower)) return true;

  return false;
}

const currentFiles = gitLines(['ls-files']);
const currentProblems = currentFiles.filter(isPrivatePath);

let historyProblems = [];
if (includeHistory) {
  historyProblems = [...new Set(gitLines(['log', 'HEAD', '--name-only', '--pretty=format:']).filter(isPrivatePath))];
}

if (currentProblems.length || historyProblems.length) {
  console.error('Git safety check failed. Private/runtime paths are tracked.');
  if (currentProblems.length) {
    console.error(`Current index (${currentProblems.length}):`);
    currentProblems.slice(0, 25).forEach((file) => console.error(`  ${file}`));
  }
  if (historyProblems.length) {
    console.error(`Git history (${historyProblems.length}):`);
    historyProblems.slice(0, 25).forEach((file) => console.error(`  ${file}`));
  }
  process.exitCode = 1;
} else {
  console.log(`Git safety check passed (${currentFiles.length} tracked files${includeHistory ? ', including history' : ''}).`);
}
