export class AdminUsernameConfigurationError extends Error {
  constructor() {
    super('ADMIN_USERNAME is required and must be non-empty; rerun the installer or set it in dashboard.env');
    this.name = 'AdminUsernameConfigurationError';
  }
}

export function requireAdminUsername(
  env: Record<string, string | undefined> = process.env,
): string {
  const username = env.ADMIN_USERNAME?.trim().toLowerCase();
  if (!username) throw new AdminUsernameConfigurationError();
  return username;
}
