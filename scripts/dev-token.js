// Development only: prints a JWT the API accepts, until phone login exists.
//   node --env-file=.env scripts/dev-token.js passenger <user-uuid>
import jwt from 'jsonwebtoken';

const [role, userId] = process.argv.slice(2);
if (!['passenger', 'driver', 'admin'].includes(role) || !userId) {
  console.error('Usage: node --env-file=.env scripts/dev-token.js <passenger|driver|admin> <user-uuid>');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set (use --env-file=.env).');
  process.exit(1);
}

console.log(
  jwt.sign({ sub: userId, role }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  }),
);
