// DEVELOPMENT ONLY. Tiny admin tool for reviewing driver applications while
// there is no admin web panel. It talks to the in-memory server's admin routes
// using the admin key.
//
//   node scripts/dev-admin.js list
//   node scripts/dev-admin.js document <driver-id> <cnic_front|cnic_back|license|vehicle_registration> [out-file]
//   node scripts/dev-admin.js approve <driver-id>
//   node scripts/dev-admin.js reject <driver-id> "reason shown to the driver"
//
// Optional: API_BASE_URL (default http://localhost:3000) and ADMIN_KEY (must
// match the server's; default is the in-memory server's dev key).
import { writeFile } from 'node:fs/promises';

const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
const adminKey = process.env.ADMIN_KEY || 'dev-admin-key';

const [command, id, arg3, arg4] = process.argv.slice(2);

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1/admin/drivers${path}`, {
    method,
    headers: {
      'x-admin-key': adminKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  return res;
}

function usage() {
  console.error(
    'Usage:\n' +
      '  node scripts/dev-admin.js list\n' +
      '  node scripts/dev-admin.js document <driver-id> <cnic_front|cnic_back|license|vehicle_registration> [out-file]\n' +
      '  node scripts/dev-admin.js approve <driver-id>\n' +
      '  node scripts/dev-admin.js reject <driver-id> "reason"',
  );
  process.exit(1);
}

if (command === 'list') {
  const { drivers } = await (await call('GET', '/pending')).json();
  if (drivers.length === 0) console.log('No pending applications.');
  for (const d of drivers) {
    console.log(
      `\n${d.name}  (${d.phone})\n` +
        `  id:       ${d.id}\n` +
        `  CNIC:     ${d.cnic}\n` +
        `  licence:  ${d.license_number}\n` +
        `  vehicle:  ${d.vehicle_reg_no}\n` +
        `  applied:  ${d.submitted_at}`,
    );
  }
} else if (command === 'document' && id && arg3) {
  const res = await call('GET', `/${id}/documents/${arg3}`);
  const type = res.headers.get('content-type');
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const out = arg4 ?? `${arg3}-${id.slice(0, 8)}.${ext}`;
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  console.log(`Saved ${out}`);
} else if (command === 'approve' && id) {
  const { driver } = await (await call('POST', `/${id}/approve`)).json();
  console.log(`Approved ${driver.name} (${driver.phone}).`);
} else if (command === 'reject' && id && arg3) {
  const { driver, rejection_reason } = await (await call('POST', `/${id}/reject`, { reason: arg3 })).json();
  console.log(`Rejected ${driver.name}: ${rejection_reason}`);
} else {
  usage();
}