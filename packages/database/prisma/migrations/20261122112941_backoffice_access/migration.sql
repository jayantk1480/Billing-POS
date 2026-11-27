-- Signing in to the back office becomes a permission of its own, so that a biller's
-- account can be limited to the billing screen.
INSERT INTO permissions (id, key, "group", description)
VALUES (gen_random_uuid(), 'backoffice.access', 'Access', 'Sign in to the back office (without it, the account works on the billing and kitchen screens only)')
ON CONFLICT (key) DO NOTHING;

-- For restaurants that already exist: every role keeps the access it had, except the
-- built-in counter and kitchen roles, which are for the billing and kitchen screens.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE p.key = 'backoffice.access' AND NOT (r.is_system AND r.key IN ('cashier', 'captain', 'kitchen'))
ON CONFLICT DO NOTHING;

-- Back-office sessions of accounts that no longer have access end now.
UPDATE sessions s SET revoked_at = now()
FROM users u
WHERE s.user_id = u.id AND s.client = 'web' AND s.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = u.role_id AND p.key = 'backoffice.access'
  );
