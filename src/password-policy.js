// Şifre politikası (NIST SP 800-63B yaklaşımı): uzunluk + yaygın/tahmin edilebilir şifrelerin engellenmesi.
// Karmaşıklık kuralları (büyük harf, sembol zorunluluğu) bilerek yok; uzun parolalar teşvik edilir.

// En yaygın sızdırılmış şifrelerden 8+ karakterli olanlar ve Türkçe yaygın örnekler (küçük harfle karşılaştırılır).
const COMMON = new Set(
  `12345678 123456789 1234567890 12345678910 87654321 11111111 00000000 88888888 99999999 12341234 11223344
  password password1 password12 password123 passw0rd p@ssw0rd p@ssword qwertyui qwerty12 qwerty123 qwerty1234
  qwertyuiop asdfghjk asdfasdf zxcvbnm1 1q2w3e4r 1qaz2wsx qazwsxedc abcd1234 abc12345 abcdefgh aaaaaaaa
  iloveyou princess sunshine football baseball superman starwars whatever trustno1 letmein1 welcome1 welcome123
  admin123 administrator changeme default1 monkey12 dragon12 master12 computer internet samsung1 google123
  sifre123 sifre1234 sifresifre parola123 parola1234 galatasaray fenerbahce besiktas trabzonspor istanbul34
  turkiye1 ankara06 izmir035 asdasdasd asd123456 qweqweqwe 123qweasd qwe123456 zaq12wsx`
    .split(/\s+/)
    .filter(Boolean),
);

const normalize = (s) => String(s ?? '').toLocaleLowerCase('tr-TR').replace(/\s+/g, '');

/**
 * Şifre zayıfsa nedenini (Türkçe) döner, değilse null. Uzunluk kontrolü şemada ayrıca yapılır.
 * @param {string} password
 * @param {{ email?: string, username?: string }} [context]
 */
export function weakPasswordReason(password, { email, username } = {}) {
  const p = normalize(password);
  if (COMMON.has(p)) return 'Bu şifre çok yaygın ve kolay tahmin edilir. Daha özgün bir şifre seçin.';
  if (/^(.)\1+$/.test(p)) return 'Şifre tek bir karakterin tekrarından oluşamaz.';
  if (isSequence(p)) return 'Şifre ardışık karakterlerden (ör. 12345678, abcdefgh) oluşamaz.';

  const mail = normalize(email);
  const local = mail.split('@')[0];
  const name = normalize(username);
  // Şifre büyük ölçüde e-postadan / addan oluşuyorsa (tekrarlar dahil): çıkarınca 6 karakterden az kalıyor
  const contains = (part) => part && part.length >= 4 && p.includes(part) && p.replaceAll(part, '').length < 6;
  if (mail && (p === mail || contains(local))) return 'Şifre e-posta adresinize çok benziyor.';
  if (name && (p === name || contains(name))) return 'Şifre adınıza / kullanıcı adınıza çok benziyor.';
  return null;
}

function isSequence(p) {
  if (p.length < 6) return false;
  const codes = [...p].map((c) => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  return Math.abs(step) === 1 && codes.every((c, i) => i === 0 || c - codes[i - 1] === step);
}
