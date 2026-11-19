# İhracat Teklif Asistanı

AI destekli ihracat teklif ve e-posta yönetim sistemi (demo sürüm).

Gelen müşteri taleplerini analiz eder, ürün kataloğuyla eşleştirir, fiyatları hesaplar ve firmaya **gönderime hazır teklif e-postası taslağı** üretir.

## Akış

1. **Müşteri talebi** – Gelen e-postayı yapıştırın veya soldaki örneklerden birini seçin.
2. **Analiz** – Firma, ülke, ürünler, miktarlar, Incoterm, ödeme koşulu, termin, aciliyet; eksik bilgiler ve satış notları çıkarılır.
3. **Teklif taslağı** – Kalemler katalogdan fiyatlanır (kademe indirimi + Incoterm farkı). Miktar, ürün, birim fiyat ve ek indirim düzenlenebilir.
4. **E-posta** – Teklif e-postası oluşturulur; kopyalanabilir, e-posta istemcisinde açılabilir ve kaydedilebilir.

> **Fiyatları AI belirlemez.** Model yalnızca talebi yorumlar ve metni yazar; tüm rakamlar `public/js/quote.js` içinde katalogdan hesaplanır.

## Çalışma modları

| Mod | Ne zaman | Analiz / e-posta | Hesap ve veriler |
|---|---|---|---|
| **AI** | Sunucu çalışıyor ve `ANTHROPIC_API_KEY` tanımlı | Claude (varsayılan `claude-opus-5-5`) | Giriş zorunlu, veriler SQLite'ta |
| **Demo** | Sunucu çalışıyor, anahtar yok | Kural tabanlı motor + şablon | Giriş zorunlu, veriler SQLite'ta |
| **Statik demo** | GitHub Pages (sunucu yok) | Tarayıcıda kural tabanlı motor + şablon | Giriş yok, veriler tarayıcıda (localStorage) |

## Hesaplar ve e-posta

- **Kayıt / giriş:** Kullanıcı adı (2–50), e-posta, şifre (8–128 karakter). Yeni hesaplar **doğrulanmamış** (`emailVerified=false`) oluşturulur; aynı e-postayla ikinci kayıt `409 EMAIL_TAKEN` alır.
- **Şifreler:** **Argon2id** (Node'un yerleşik `crypto.argon2`'si, ek paket yok), OWASP parametreleri `m=19 MiB, t=2, p=1`, kullanıcı başına rastgele tuz, PHC biçimi. Eski scrypt hash'leri girişte otomatik Argon2id'ye yükseltilir. Hash'ler hiçbir API yanıtında dönmez.
- **Oturum çerezi:** rastgele 256 bit token (veritabanında yalnızca SHA-256 özeti), 30 gün.
  - Geliştirme: `ita_session; HttpOnly; SameSite=Lax; Path=/`
  - Canlı (`NODE_ENV=production`, HTTPS zorunlu): `__Host-ita_session; HttpOnly; Secure; SameSite=Lax; Path=/`
  - Çıkışta oturum sunucuda da silinir; kopyalanmış eski çerez işe yaramaz.
- **Şifre politikası:** yaygın / sızdırılmış şifreler (ör. `12345678`, `password`, `qwerty123`), tek karakter tekrarı, ardışık karakterler ve e-postaya / ada çok benzeyen şifreler reddedilir (`src/password-policy.js`).
- **Hız sınırları:** kayıt / giriş / şifre uçlarında IP başına 15 dakikada 20 istek; ayrıca **hesap başına 15 dakikada 10 başarısız giriş** (farklı IP'lerden dağıtık denemelere karşı; başarılı girişler sayılmaz); analiz / taslak uçlarında kullanıcı başına 15 dakikada 60 istek. Aşılınca `429 RATE_LIMITED` + `Retry-After`.
- **Oturum değişimi:** giriş / kayıt / şifre sıfırlamada tarayıcının önceki oturumu sunucuda da kapatılır.
- **Günlükler:** canlı ortamda e-posta servisi tanımlı değilse doğrulama / sıfırlama bağlantıları günlüğe yazılmaz.
- **Hata biçimi (tüm API):** `{ "error": "Türkçe mesaj", "code": "MAKINE_KODU", "fields"?: { "alan": "mesaj" } }` — kodlar: `VALIDATION_ERROR`, `INVALID_JSON`, `EMAIL_TAKEN`, `INVALID_CREDENTIALS`, `UNAUTHENTICATED`, `INVALID_TOKEN`, `RATE_LIMITED`, `EMAIL_SEND_FAILED`, `FORBIDDEN_ORIGIN`, `NOT_FOUND`, `INTERNAL_ERROR`.
- **Şifremi unuttum:** Sıfırlama bağlantısı 1 saat geçerlidir ve tek kullanımlıktır; sıfırlamada diğer cihazlardaki oturumlar kapanır.
- **Teklif gönderme:** E-posta kartındaki **Gönder** butonu teklifi sunucu üzerinden gönderir (yanıt adresi: firma ayarlarındaki e-posta). Doğrulanmış hesap gerekir. Kayıtlı teklif gönderilince durumu `sent` olur.
- **Eski veriler:** Tarayıcıda (localStorage) kayıtlı teklifler ve firma ayarları ilk girişte hesaba aktarılır.

## İşlemsel e-postalar (Resend)

E-postalar [Resend](https://resend.com) HTTP API'siyle gönderilir (SDK yok, `fetch` ile tek uç: `POST /emails`).

**Yapı** — kimlik doğrulama kodu e-postanın nasıl gönderildiğini bilmez:

```
src/email/providers.js   Resend sağlayıcısı (+ geliştirme için konsol, testler için bellek sağlayıcısı)
src/email/templates.js   Markalı HTML + düz metin şablonlar (doğrulama, şifre sıfırlama)
src/email/service.js     Yeniden kullanılabilir servis: şablon + gönderen + sağlayıcı
src/email-tokens.js      Tek kullanımlık token'lar (üret / doğrula / tüket)
src/verification.js      Doğrulama akışı: token üret → gönder → doğrula; tekrar gönderme bekleme süresi
```

**Doğrulama akışı**

1. `POST /api/auth/register` → hesap `emailVerified=false` oluşur, doğrulama e-postası gönderilir. Yanıttaki `verificationEmail` gerçeği söyler: `{ sent: true, delivery: "resend" }`, geliştirme modunda `{ sent: false, delivery: "console" }`, sağlayıcı hata verirse `{ sent: false, error: "…" }` (hesap yine oluşur).
2. E-postadaki bağlantı `APP_URL/#verify=<token>` — token URL'nin `#` kısmındadır: sunucu günlüklerine/Referer'a düşmez ve e-posta tarayıcılarının bağlantıyı önceden açması (GET) token'ı tüketemez.
3. Sayfa token'ı `POST /api/auth/verify-email { token }` ile gönderir → `emailVerified=true`, kullanıcının diğer doğrulama token'ları da geçersiz olur.
4. `POST /api/auth/resend-verification` (giriş gerekli) → yeni token + e-posta; önceki token geçersiz olur. Sınırlar: iki gönderim arasında **60 sn**, kullanıcı başına **saatte 5**; sağlayıcı hatasında `502 EMAIL_SEND_FAILED` (asla "gönderildi" denmez).

**Token güvenliği:** 256 bit `crypto.randomBytes` (base64url) · veritabanında yalnızca **SHA-256 özeti** · varsayılan **24 saat** geçerli · tek kullanımlık (eşzamanlı isteklerde de) · süresi dolmuş / kullanılmış / şifre sıfırlama token'ları doğrulama yapamaz.

**Ortam değişkenleri**

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `RESEND_API_KEY` | Gerçek gönderim için | resend.com → API Keys ("Sending access"). `re_` ile başlar. **Gizli**: yalnızca `.env`'de veya barındırma servisinin gizli değişkenlerinde; hiçbir yanıtta/günlükte görünmez. Boşsa geliştirme modu: e-posta gönderilmez, içerik sunucu konsoluna yazılır. |
| `MAIL_FROM` | Canlıda (anahtar varsa) | Resend'de doğrulanmış alan adından gönderen, ör. `EasyHustle <no-reply@alanadiniz.com>`. Boşsa `onboarding@resend.dev` (yalnızca Resend hesap sahibinin adresine gönderebilir — deneme için). |
| `MAIL_REPLY_TO` | Hayır | Yanıtların gideceği adres. |
| `APP_NAME` | Hayır | E-postalardaki marka adı (varsayılan `EasyHustle`). |
| `APP_URL` | Canlıda | E-postadaki bağlantıların adresi (canlıda `https://`). |
| `EMAIL_VERIFICATION_TTL_HOURS` | Hayır | Doğrulama bağlantısı süresi, 1–168 saat (varsayılan 24). |

Resend hesabı, API anahtarı ve alan adı doğrulama adımları: [KURULUM.md → Resend kurulumu](KURULUM.md#6-resend-kurulumu-gerçek-e-posta-için).

## Veritabanı (Prisma + SQLite)

- Şema: [`prisma/schema.prisma`](prisma/schema.prisma) — `User` (id, username, email *(benzersiz)*, passwordHash, emailVerified, createdAt, updatedAt) ile `Session`, `EmailToken`, `CompanySettings`, `Quote`, `EmailLog`.
- Migration'lar: `prisma/migrations/` (ilki `…_init`). Bağlantı: [`src/db.js`](src/db.js) — adaptörü `DATABASE_URL`'e göre seçer, açılışta bağlantıyı ve tabloları doğrular, kapanışta bağlantıyı kapatır.
- Varsayılan adres `DATABASE_URL="file:./data/dev.db"` (göreli yol proje klasörüne göre). `data/` ve üretilen istemci (`src/generated/`) git'e eklenmez; `npm install` istemciyi otomatik üretir.
- Şifreler asla düz metin saklanmaz (Argon2id, kullanıcı başına rastgele tuz). Oturum ve e-posta token'larının da yalnızca SHA-256 özeti saklanır.
- **PostgreSQL'e geçiş:** `schema.prisma` başındaki 4 adım (provider → `postgresql`, `npm install @prisma/adapter-pg pg`, `DATABASE_URL`, yeni `init` migration'ı). Modellerde SQLite'a özgü bir şey yok.
- Prisma öncesi sürümden (`data/app.db`) gelen hesaplar `npm run db:import-legacy` ile aktarılır (tekrar çalıştırmak güvenlidir).

| Komut | Ne yapar |
|---|---|
| `npm run db:migrate` | Şema değişikliğinden yeni migration oluşturur ve uygular (geliştirme) |
| `npm run db:deploy` | Bekleyen migration'ları uygular (canlı ortam; `dev`/`start` öncesi otomatik çalışır) |
| `npm run db:generate` | Prisma istemcisini yeniden üretir |
| `npm run db:studio` | Veritabanını tarayıcıda görüntüleme aracı |

Proje OneDrive gibi eşitlenen bir klasördeyse, eşitleme sırasında kilitlenme yaşamamak için `DATABASE_URL` ile eşitlenmeyen bir yol seçmeniz önerilir.

## Yerelde çalıştırma (localhost)

> **Adım adım kurulum, tüm ortam değişkenleri, Resend / alan adı ayarı, e-posta doğrulamayı test etme ve temiz ortam kontrol listesi: [KURULUM.md](KURULUM.md)**

Gereksinim: Node.js 24.7+ (yerleşik Argon2id; Prisma'nın ürettiği TypeScript istemcisi derleme olmadan çalışır). Frontend ve backend aynı sunucuda çalışır.

```bash
npm install
```

```bash
cp .env.example .env
```

(Windows PowerShell: `Copy-Item .env.example .env`.) Değer doldurmadan da çalışır: AI yerine kural tabanlı analiz, e-posta yerine konsol çıktısı. Sonra:

```bash
npm run dev
```

Tarayıcıda: http://localhost:3000

| Komut | Ne yapar |
|---|---|
| `npm run dev` | Migration'ları uygular, sonra geliştirme sunucusu (kod değişince otomatik yeniden başlar) |
| `npm start` | Migration'ları uygular, sunucuyu `.env`'deki `NODE_ENV` ile başlatır (varsayılan development) |
| `npm run start:prod` | Migration'ları uygular, canlı ortam: `NODE_ENV=production` (güvenli çerez, HTTPS yükseltme, `APP_URL` zorunlu) |
| `npm test` | Tüm testler (`node --test`) |
| `npm run health` | Çalışan sunucunun sağlık kontrolü (`/api/health`) |

`.env` dosyası Node'un yerleşik `process.loadEnvFile()` fonksiyonuyla proje klasöründen yüklenir; ortamda zaten tanımlı değişkenler ezilmez (barındırma servisinde değişkenleri panelden tanımlayın, `.env` yüklemeyin). Değerler `src/config.js` içinde doğrulanır; hatalı bir değer varsa sunucu açıklayıcı bir mesajla başlamaz.

### Sağlık kontrolü

`GET /api/health` → `200 { status: "ok", service, version, environment, uptimeSeconds, timestamp, checks: { database: "ok" } }`. Veritabanına erişilemezse `503` ve `status: "error"` döner. Oturum gerektirmez, gizli bilgi içermez.

### CORS

Frontend bu sunucudan sunulduğu için varsayılan olarak CORS kapalıdır (yalnızca aynı adres). Frontend ayrı bir adreste barındırılacaksa `CORS_ORIGINS` ile tam adresleri virgülle listeleyin; bu adreslere çerezli istek izni verilir, diğerleri reddedilir.

## GitHub'da demo yayınlama

1. GitHub'da yeni bir repo oluşturun ve bu projeyi `main` dalına gönderin.
2. Repo → **Settings → Pages → Source: GitHub Actions** seçin.
3. Her `main` push'unda `.github/workflows/pages.yml` testleri çalıştırır ve `public/` klasörünü yayınlar.

Pages sürümü sunucusuz çalıştığı için **API anahtarı içermez**; kural tabanlı statik demo olarak çalışır. AI'lı sürüm için sunucuyu (`server.js`) bir Node barındırma servisinde çalıştırmak gerekir. **API anahtarını asla frontend koduna veya repoya koymayın.**

## Proje yapısı

```
server.js                    Sunucuyu başlatır (.env → yapılandırma → veritabanı → e-posta → Express), düzgün kapanış
src/config.js                Ortam değişkenlerinin okunması ve doğrulanması
src/app.js                   Express uygulaması: güvenlik başlıkları, CORS, route'ların bağlanması
src/cors.js                  CORS ve güvenilir kaynak (CSRF) kontrolü
src/http.js                  Merkezi hata yönetimi, 404, doğrulama yardımcıları
src/ai.js                    Claude entegrasyonu (yapılandırılmış çıktı)
src/routes/health.js         /api/health
src/routes/ai.js             /api/status, /api/analyze, /api/draft-email
prisma/schema.prisma         Veritabanı şeması (Prisma)
prisma/migrations/           SQL migration'ları
prisma.config.ts             Prisma CLI yapılandırması
src/db.js                    Prisma istemcisi, bağlantı, sağlık sorgusu
src/database-url.js          DATABASE_URL çözümleme (uygulama ve CLI ortak)
src/generated/prisma/        Üretilen Prisma istemcisi (git'e eklenmez)
scripts/import-legacy-db.js  Eski data/app.db verilerini aktarma
src/password.js              Şifre hash'leme (Argon2id, eski scrypt doğrulama + yükseltme)
src/password-policy.js       Zayıf şifre kontrolü
src/auth.js                  Kullanıcılar, oturumlar, çerez ayarları, auth middleware
src/email/                   E-posta servisi, Resend sağlayıcısı, HTML şablonlar
src/email-tokens.js          Tek kullanımlık e-posta token'ları
src/verification.js          E-posta doğrulama akışı
src/routes/auth.js           /api/auth/* uçları
src/routes/data.js           /api/settings, /api/quotes, /api/email/send
public/index.html            Arayüz
public/css/styles.css
public/js/app.js             Arayüz mantığı
public/js/quote.js           Teklif hesaplama (ortak)
public/js/demo-analyzer.js   Kural tabanlı analiz + e-posta şablonu (ortak)
public/data/catalog.json     Ürün kataloğu, fiyatlar, indirimler, Incoterm farkları
public/data/sample-requests.json  Örnek müşteri talepleri
test/                        Testler (node --test): veritabanı, API, teklif motoru — her çalıştırmada
                             migration'larla geçici bir SQLite veritabanı oluşturulur
```

### API

- `GET /api/health` → sağlık kontrolü (yukarıya bakın)
- `GET /api/status` → `{ mode: "ai" | "demo", model, auth: true, mailDelivery }`
- `POST /api/analyze` 🔒 → gövde `{ from, subject, body }`, yanıt: analiz nesnesi
- `POST /api/draft-email` 🔒 → gövde `{ request, analysis, quote, settings }`, yanıt `{ subject, body }`

Hesap:

- `POST /api/auth/register` `{ name, email, password }` · `POST /api/auth/login` `{ email, password }` · `POST /api/auth/logout` · `GET /api/auth/me`
- `POST /api/auth/verify-email` `{ token }` · `POST /api/auth/resend-verification` 🔒
- `POST /api/auth/forgot-password` `{ email }` · `POST /api/auth/reset-password` `{ token, password }`

Veriler (🔒 hepsi giriş gerektirir, her kullanıcı yalnızca kendi verisini görür):

- `GET/PUT /api/settings` — firma ayarları
- `GET/POST /api/quotes`, `PUT/DELETE /api/quotes/:id`, `PATCH /api/quotes/:id/status` `{ status }`, `POST /api/quotes/import` `{ quotes }`
- `POST /api/email/send` `{ to, subject, body, quoteId? }` — doğrulanmış e-posta gerektirir

Güvenlik: `helmet` başlıkları (CSP, nosniff, no-referrer, HSTS), IP / hesap / kullanıcı başına hız sınırları (bkz. "Hesaplar ve e-posta"), başka siteden gelen (farklı `Origin`) yazma isteklerinin reddi, tüm girdilerin `zod` ile doğrulanması.

AI çağrısı başarısız olursa sunucu otomatik olarak kural tabanlı sonuca döner ve yanıta `warning` ekler.

## Kendi firmanıza uyarlama

- Ürünler, fiyatlar, MOQ, termin, kademe indirimleri ve Incoterm farkları: `public/data/catalog.json`
- Firma adı, imza, teklif geçerliliği, varsayılan ödeme koşulu: arayüzde **Firma ayarları** (sunucu modunda hesapta, statik demoda tarayıcıda saklanır)

## Yol haritası

- [ ] Müşteri diline otomatik çeviri (gönderim aşamasında)
- [ ] Gelen kutusu entegrasyonu (IMAP / Gmail / Outlook)
- [x] Kullanıcı hesapları (kayıt, giriş, e-posta doğrulama, şifre sıfırlama)
- [x] Veritabanı ile teklif geçmişi ve durum (taslak / gönderildi / kabul / ret — API hazır)
- [x] İşlemsel e-postalar (Resend) ve teklif e-postasını sunucudan gönderme
- [ ] Teklif durumunu arayüzden değiştirme (kabul / ret)
- [ ] PDF teklif çıktısı
- [ ] Döviz kuru ve navlun maliyeti entegrasyonu
