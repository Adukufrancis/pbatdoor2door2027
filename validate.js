// Server-side validation for the sign-up / profile form.
// The browser checks the same things, but the server is the one that counts.

export const STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River',
  'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];
export const GENDERS = ['Male', 'Female', 'Prefer not to say'];
export const INTERESTS = [
  'Door-to-door canvassing', 'Community mobilisation', 'Social media', 'Logistics & transport',
  'Polling unit agent', 'Events & rallies', 'Fundraising',
];

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  let m;
  if ((m = digits.match(/^\+?234([789]\d{9})$/))) return `+234${m[1]}`;
  if ((m = digits.match(/^0([789]\d{9})$/))) return `+234${m[1]}`;
  return null;
}

function ageOn(dobStr, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobStr);
  if (!m) return null;
  const dob = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(dob.getTime()) || dob.getUTCDate() !== +m[3]) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const md = (now.getUTCMonth() - dob.getUTCMonth()) || (now.getUTCDate() - dob.getUTCDate());
  if (md < 0) age--;
  return age;
}

export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

/** Works out whether the sign-in box holds an email or a Nigerian phone number. */
export function parseIdentifier(raw) {
  const s = String(raw || '').trim();
  if (s.includes('@')) {
    const email = s.toLowerCase();
    return isEmail(email) ? { type: 'email', value: email } : null;
  }
  const phone = normalizePhone(s);
  return phone ? { type: 'phone', value: phone } : null;
}

/** Returns { profile } on success or { errors: {field: message} } on failure. */
export function validateProfile(input, { requireConsent = true } = {}) {
  const errors = {};
  const p = {};

  p.full_name = clean(input.full_name, 100);
  if (p.full_name.split(' ').filter(Boolean).length < 2 || p.full_name.length < 4) {
    errors.full_name = 'Enter your first and last name.';
  }

  p.gender = clean(input.gender, 30);
  if (p.gender && !GENDERS.includes(p.gender)) errors.gender = 'Choose an option.';

  p.date_of_birth = clean(input.date_of_birth, 10);
  const age = ageOn(p.date_of_birth);
  if (!p.date_of_birth) { /* optional */ }
  else if (age == null) errors.date_of_birth = 'Enter a real date as DD/MM/YYYY, e.g. 28/11/2000.';
  else if (age < 18) errors.date_of_birth = 'You must be 18 or older to join.';
  else if (age > 120) errors.date_of_birth = 'Check your date of birth.';

  p.state = clean(input.state, 40);
  if (!STATES.includes(p.state)) errors.state = 'Choose your state.';

  p.lga = clean(input.lga, 60);
  if (p.lga.length < 2) errors.lga = 'Enter your local government area.';

  p.ward = clean(input.ward, 80);
  p.polling_unit = clean(input.polling_unit, 160);
  p.address = clean(input.address, 200);
  p.occupation = clean(input.occupation, 80);

  const interests = Array.isArray(input.interests) ? input.interests : [];
  p.interests = interests.filter((i) => INTERESTS.includes(i)).join(', ');

  if (requireConsent && input.consent !== true) {
    errors.consent = 'Please agree so we can store your details.';
  }

  return Object.keys(errors).length ? { errors } : { profile: p };
}
