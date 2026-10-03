// Usage: npm run make-admin -- someone@example.com [reviewer|approver|owner]
// Adds (or updates) an admin. They become active the first time they sign in with that email.
import { query, pool } from '../server/db.js';

const [email, role = 'approver'] = process.argv.slice(2);
if (!email || !['reviewer', 'approver', 'owner'].includes(role)) {
  console.error('Usage: npm run make-admin -- email@example.com [reviewer|approver|owner]');
  process.exit(1);
}
await query(
  `insert into admin_users (email, role, status) values (lower($1), $2, 'pending')
   on conflict (email) do update set role = excluded.role,
     status = case when admin_users.status = 'revoked' then 'pending' else admin_users.status end`,
  [email.trim(), role]);
console.log(`${email} is now an admin (${role}).`);
await pool.end();
