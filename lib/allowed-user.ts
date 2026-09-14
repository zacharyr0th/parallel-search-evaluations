export function allowedEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const normalized = email.toLowerCase();
  return normalized === "eas.vone@gmail.com" || /^[^\s@]+@parallel\.ai$/.test(normalized);
}

export function allowedUser(
  user: { email?: unknown; emailVerified?: unknown } | null | undefined,
): boolean {
  return user?.emailVerified === true && allowedEmail(user.email);
}
