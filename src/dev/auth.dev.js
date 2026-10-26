export function devAuth(req, res, next) {
  // Accept any token, or no token at all
  req.user = {
    id: '11111111-1111-1111-1111-111111111111',
    role: 'passenger',
    name: 'Test Passenger',
  };
  next();
}