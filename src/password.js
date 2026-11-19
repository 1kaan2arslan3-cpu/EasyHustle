// Şifre hash'leme: Argon2id (Node'un yerleşik crypto.argon2'si — ek paket yok).
// Parametreler OWASP Password Storage Cheat Sheet önerisi: m=19 MiB, t=2, p=1.
// Hash'ler standart PHC biçiminde saklanır: $argon2id$v=19$m=19456,t=2,p=1$<tuz>$<özet>
// Önceki sürümün scrypt hash'leri hâlâ doğrulanır ve girişte Argon2id'ye yükseltilir (needsRehash).
import { argon2 as argon2Cb, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2 = promisify(argon2Cb);
const scrypt = promisify(scryptCb);

export const ARGON2 = Object.freeze({ memory: 19456, passes: 2, parallelism: 1, tagLength: 32, saltLength: 16 });

const b64 = (buf) => buf.toString('base64').replace(/=+$/, ''); // PHC: dolgusuz base64
const unb64 = (s) => Buffer.from(s, 'base64');

async function argon2id(password, salt, { memory, passes, parallelism, tagLength }) {
  return argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, memory, passes, parallelism, tagLength });
}

/** @returns {Promise<string>} PHC biçiminde Argon2id hash'i */
export async function hashPassword(password) {
  const salt = randomBytes(ARGON2.saltLength);
  const hash = await argon2id(password, salt, ARGON2);
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`;
}

/**
 * @returns {Promise<{ ok: boolean, needsRehash: boolean }>}
 *   needsRehash: şifre doğru ama hash eski yöntemle/parametrelerle üretilmiş → yeniden hash'lenmeli
 */
export async function verifyPassword(password, stored) {
  const value = String(stored ?? '');

  // $argon2id$v=19$m=..,t=..,p=..$salt$hash
  const m = value.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  if (m) {
    const [, memory, passes, parallelism, salt, hash] = m;
    const expected = unb64(hash);
    const params = { memory: +memory, passes: +passes, parallelism: +parallelism, tagLength: expected.length };
    const actual = await argon2id(password, unb64(salt), params);
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    const outdated = params.memory !== ARGON2.memory || params.passes !== ARGON2.passes || params.parallelism !== ARGON2.parallelism || expected.length !== ARGON2.tagLength;
    return { ok, needsRehash: ok && outdated };
  }

  // Eski biçim: scrypt$N$r$p$salt$hash
  const [alg, N, r, p, salt, hash] = value.split('$');
  if (alg === 'scrypt' && salt && hash) {
    const expected = unb64(hash);
    const actual = await scrypt(password, unb64(salt), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    const ok = timingSafeEqual(actual, expected);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}

// Kullanıcı yokken de aynı süre harcansın (e-postanın kayıtlı olup olmadığı yanıt süresinden anlaşılmasın)
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}
