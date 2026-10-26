-- 1) Log in once in the app with 0300 0000000 (this creates the user).
-- 2) Then run this once:
UPDATE users SET role = 'admin' WHERE phone = '+923000000000';

-- Check it:
SELECT id, name, phone, role FROM users WHERE role = 'admin';

-- Remove admin access later:
-- UPDATE users SET role = 'passenger' WHERE phone = '+923000000000';
