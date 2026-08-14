// ── Username and password rules ──────────────────────────────────────────────
//
// Canonical implementation. The server requires this file directly; the web
// client loads it as /js/credentials.js; native-app/src/credentials.ts mirrors
// it exactly. test/credentials.test.js runs the same table of cases through
// both copies, so the mirror cannot silently drift.
//
// The password rules follow NIST SP 800-63B rather than the older folklore:
// length and a blocklist of known-bad choices, NOT composition rules. Demanding
// an uppercase letter and a symbol reliably produces "Password1!" — weak AND
// forgotten — which is the worst outcome for users who are not confident with
// computers.

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

// Names that would be confusing or impersonating in a chat.
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'staff',
  'moderator', 'mod', 'owner', 'official', 'security', 'info', 'contact',
  'chatroom', 'bistbarg', 'everyone', 'all', 'here', 'me', 'you', 'null',
  'undefined', 'anonymous', 'deleted', 'bot',
]);

// The passwords people actually pick. Short list on purpose: it catches the
// overwhelming majority of real-world bad choices without shipping a dictionary.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  '1234567890', '123123123', '11111111', '00000000', '87654321', 'qwertyui',
  'qwerty123', 'asdfghjk', 'abc12345', 'iloveyou', 'letmein1', 'welcome1',
  'sunshine', 'princess', 'football', 'baseball', 'trustno1', 'superman',
  'starwars', 'whatever', 'freedom1', 'computer', 'dragon12', 'monkey12',
  'a1234567', 'zxcvbnm1', '1q2w3e4r', 'qazwsxedc', 'admin123', 'root1234',
]);

// Normalised form used for storage and uniqueness: usernames are
// case-insensitive, so "Ako" and "ako" are the same account and cannot both
// exist. Without this, a typo'd capital creates a second account and the user
// reports it as "I forgot my password".
function normalizeUsername(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// Returns null when valid, otherwise { code, en, fa }.
function validateUsername(raw) {
  const name = normalizeUsername(raw);
  if (!name) {
    return { code: 'required', en: 'Choose a username.', fa: 'یک نام کاربری انتخاب کنید.' };
  }
  if (name.length < USERNAME_MIN) {
    return {
      code: 'short',
      en: `At least ${USERNAME_MIN} characters.`,
      fa: `حداقل ${USERNAME_MIN} حرف.`,
    };
  }
  if (name.length > USERNAME_MAX) {
    return {
      code: 'long',
      en: `At most ${USERNAME_MAX} characters.`,
      fa: `حداکثر ${USERNAME_MAX} حرف.`,
    };
  }
  if (!/^[a-z]/.test(name)) {
    return {
      code: 'start',
      en: 'Must start with a letter (a–z).',
      fa: 'باید با یک حرف انگلیسی (a–z) شروع شود.',
    };
  }
  if (!/^[a-z0-9._]+$/.test(name)) {
    return {
      code: 'charset',
      en: 'Only letters, numbers, dot and underscore.',
      fa: 'فقط حروف انگلیسی، عدد، نقطه و زیرخط.',
    };
  }
  if (/[._]$/.test(name)) {
    return {
      code: 'end',
      en: 'Cannot end with a dot or underscore.',
      fa: 'نمی‌تواند به نقطه یا زیرخط ختم شود.',
    };
  }
  if (/[._]{2}/.test(name)) {
    return {
      code: 'repeat',
      en: 'No two dots or underscores in a row.',
      fa: 'دو نقطه یا زیرخط پشت سر هم مجاز نیست.',
    };
  }
  if (RESERVED.has(name)) {
    return {
      code: 'reserved',
      en: 'That username is reserved. Pick another.',
      fa: 'این نام کاربری رزرو شده است. نام دیگری انتخاب کنید.',
    };
  }
  return null;
}

// Returns null when valid, otherwise { code, en, fa }.
// `username` is optional and only used to reject a password that is basically
// the username again.
function validatePassword(raw, username) {
  const pw = String(raw == null ? '' : raw);
  if (!pw) {
    return { code: 'required', en: 'Choose a password.', fa: 'یک رمز عبور انتخاب کنید.' };
  }
  if (pw.length < PASSWORD_MIN) {
    return {
      code: 'short',
      en: `At least ${PASSWORD_MIN} characters.`,
      fa: `حداقل ${PASSWORD_MIN} کاراکتر.`,
    };
  }
  if (pw.length > PASSWORD_MAX) {
    return {
      code: 'long',
      en: `At most ${PASSWORD_MAX} characters.`,
      fa: `حداکثر ${PASSWORD_MAX} کاراکتر.`,
    };
  }
  if (pw.trim().length === 0) {
    return {
      code: 'blank',
      en: 'Cannot be only spaces.',
      fa: 'نمی‌تواند فقط فاصله باشد.',
    };
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    return {
      code: 'common',
      en: 'That password is too common — it is one of the first anyone would try.',
      fa: 'این رمز عبور بسیار رایج است — از اولین گزینه‌هایی است که هر کسی امتحان می‌کند.',
    };
  }
  // "aaaaaaaa", "11111111"
  if (/^(.)\1+$/.test(pw)) {
    return {
      code: 'repeat',
      en: 'Cannot be the same character repeated.',
      fa: 'نمی‌تواند تکرار یک کاراکتر باشد.',
    };
  }
  // "12345678", "abcdefgh" and their reverses
  if (isSequential(pw)) {
    return {
      code: 'sequence',
      en: 'Cannot be a simple sequence like 12345678.',
      fa: 'نمی‌تواند دنباله ساده مانند ۱۲۳۴۵۶۷۸ باشد.',
    };
  }
  const uname = normalizeUsername(username);
  if (uname && pw.toLowerCase().includes(uname)) {
    return {
      code: 'username',
      en: 'Cannot contain your username.',
      fa: 'نمی‌تواند شامل نام کاربری شما باشد.',
    };
  }
  return null;
}

function isSequential(pw) {
  if (pw.length < 4) return false;
  let up = true, down = true;
  for (let i = 1; i < pw.length; i++) {
    const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

// 0–4, for the strength bar. Deliberately about length and variety rather than
// enforced rules: it advises, it does not gate.
function passwordStrength(raw) {
  const pw = String(raw == null ? '' : raw);
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(pw)).length;
  if (classes >= 3) score++;
  if (COMMON_PASSWORDS.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw) || isSequential(pw)) return 0;
  return Math.min(4, score);
}

const STRENGTH_LABELS = [
  { en: 'Very weak', fa: 'بسیار ضعیف' },
  { en: 'Weak', fa: 'ضعیف' },
  { en: 'Fair', fa: 'متوسط' },
  { en: 'Good', fa: 'خوب' },
  { en: 'Strong', fa: 'قوی' },
];

// The warning that must appear wherever a password is chosen. Losing it is
// unrecoverable by design — the E2E private key is unwrapped with it.
const PASSWORD_WARNING = {
  en: 'If you forget your password, your account and all your messages are lost forever. There is no way to recover them. Remember it, or write it down somewhere safe.',
  fa: 'اگر رمز عبور خود را فراموش کنید، حساب و همهٔ پیام‌های شما برای همیشه از دست می‌رود و هیچ راهی برای بازیابی آن وجود ندارد. آن را به خاطر بسپارید یا در جایی امن یادداشت کنید.',
};

const API = {
  USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, PASSWORD_MAX,
  normalizeUsername, validateUsername, validatePassword,
  passwordStrength, STRENGTH_LABELS, PASSWORD_WARNING,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Credentials = API;
