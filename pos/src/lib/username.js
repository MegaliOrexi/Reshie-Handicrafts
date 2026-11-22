// Cashiers log in with a short username (e.g. "ali") instead of a full email.
// Supabase Auth still needs an email, so a username is stored as
// "<username>@<STAFF_DOMAIN>". Anything containing "@" is used as-is (owner).
// No mail is ever sent to these addresses (users are created with auto-confirm).
export const STAFF_DOMAIN = 'reshiehandicrafts.com'

export const toLoginEmail = (input) => {
  const v = input.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${STAFF_DOMAIN}`
}

// Show "ali" rather than "ali@staff.reshiehandicrafts.com"
export const displayLogin = (email) =>
  email?.endsWith(`@${STAFF_DOMAIN}`) ? email.slice(0, -(STAFF_DOMAIN.length + 1)) : email
