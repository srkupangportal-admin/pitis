const Database = require('better-sqlite3');

const p = 'D:/schoolportal/pitis/data/restored-2026-06-11.sqlite';
const db = new Database(p, { readonly: true });

console.log('Checking database:', p);

for (const t of ['users', 'students', 'pitis_awards', 'awards']) {
  try {
    const result = db.prepare(`select count(*) as count from ${t}`).get();
    console.log(t, result);
  } catch (e) {
    console.log(t, 'missing');
  }
}

try {
  const admins = db.prepare(`
    select id, username, name, role
    from users
    where username like '%portal%'
       or name like '%portal%'
       or username like '%admin%'
       or role like '%admin%'
  `).all();

  console.log('Possible admin users:');
  console.log(admins);
} catch (e) {
  console.log('Could not read admin users:', e.message);
}
