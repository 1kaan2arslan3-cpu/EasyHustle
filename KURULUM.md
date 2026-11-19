# EasyHustle — Yerel Kurulum ve Demo Rehberi

Bu rehber, projeyi **sıfırdan** (boş bir bilgisayarda) çalıştırıp kayıt → e-posta doğrulama → giriş → çıkış akışını göstermek için gereken her şeyi anlatır.

Frontend (`public/`) ve backend (`server.js` + `src/`) **tek bir Node.js sunucusunda birlikte çalışır**: sunucu hem API'yi (`/api/...`) hem arayüzü aynı adresten (`http://localhost:3000`) sunar. Ayrı bir frontend sunucusu veya derleme adımı yoktur.

---

## 1. Gereksinimler

| Araç | Sürüm | Not |
|---|---|---|
| **Node.js** | **24.7 veya üstü** (LTS önerilir) | Yerleşik Argon2id şifre hash'leme bu sürümle geldi. `node --version` ile kontrol edin. |
| npm | Node.js ile gelir | |
| Git | herhangi | Yalnızca projeyi klonlamak / değişiklikleri kaydetmek için |
| Resend hesabı | isteğe bağlı | Gerçek e-posta göndermek için. Yoksa e-postalar sunucu konsoluna yazılır (bkz. §7). |

Ek veritabanı sunucusu **gerekmez**: SQLite dosyası (`data/dev.db`) otomatik oluşturulur.

---

## 2. Kurulum

```bash
git clone <repo-adresi> easyhustle
cd easyhustle
npm install
```

`npm install` sırasında Prisma istemcisi otomatik üretilir (`postinstall` → `prisma generate`, çıktı `src/generated/prisma/`, git'e eklenmez).

Ortam dosyasını oluşturun:

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
```

```bash
# macOS / Linux
cp .env.example .env
```

> Hiçbir değeri doldurmasanız da uygulama çalışır: AI yerine kural tabanlı analiz, e-posta yerine konsol çıktısı kullanılır. Yerel demo için bu yeterlidir.

---

## 3. Ortam değişkenleri

Tamamı `.env.example` dosyasında açıklamalarıyla birlikte listelidir. Yerel demo için **hiçbiri zorunlu değildir**.

| Değişken | Varsayılan | Ne zaman gerekli | Açıklama |
|---|---|---|---|
| `NODE_ENV` | `development` | — | `production` yapıldığında güvenli çerez + HTTPS kuralları devreye girer (`npm run start:prod` bunu kendisi yapar). |
| `PORT` | `3000` | Port doluysa | Sunucu portu. |
| `APP_URL` | `http://localhost:PORT` | Canlıda zorunlu (`https://`) | E-postadaki bağlantıların adresi. |
| `DATABASE_URL` | `file:./data/dev.db` | — | SQLite dosyası (proje klasörüne göre). PostgreSQL için `postgresql://...` |
| `BREVO_API_KEY` | *(boş)* | Alan adsız gerçek e-posta için | `xkeysib-...` — **gizli**. Tanımlıysa Resend yerine Brevo kullanılır; `MAIL_FROM` zorunlu (§6.4). |
| `RESEND_API_KEY` | *(boş)* | Gerçek e-posta için | `re_...` — **gizli**. İkisi de boşsa e-postalar gönderilmez, konsola yazılır. |
| `MAIL_FROM` | `EasyHustle <onboarding@resend.dev>` | Canlıda zorunlu | Resend'de doğrulanmış alan adından gönderen adres. |
| `MAIL_REPLY_TO` | *(boş)* | — | Yanıtların gideceği adres. |
| `APP_NAME` | `EasyHustle` | — | E-postalardaki marka adı. |
| `EMAIL_VERIFICATION_TTL_HOURS` | `24` | — | Doğrulama bağlantısının süresi (1–168 saat). |
| `CORS_ORIGINS` | *(boş)* | Frontend ayrı adresteyse | Virgülle ayrılmış tam adresler. |
| `TRUST_PROXY` | `false` | Ters vekil arkasında | Hız sınırlarının gerçek IP'yi görmesi için. |
| `COOKIE_SAMESITE` | `lax` | — | `none` yalnızca canlıda + ayrı alan adındaki frontend için. |
| `ANTHROPIC_API_KEY` | *(boş)* | AI analizi için | Boşsa kural tabanlı demo modu. **Gizli.** |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `DEMO_MODE` | — | — | AI ayarları (bkz. `.env.example`). |
| `RESEND_API_URL` | `https://api.resend.com` | — | İleri düzey; yalnızca testlerde değiştirilir. |

Değerler sunucu açılırken `src/config.js` içinde doğrulanır; hatalı bir değer (ör. `re_` ile başlamayan anahtar, geçersiz `MAIL_FROM`) varsa sunucu **açıklayıcı bir mesajla başlamaz**.

---

## 4. Veritabanı (migration)

Şema `prisma/schema.prisma`, migration'lar `prisma/migrations/` klasöründedir.

| Komut | Ne zaman |
|---|---|
| `npm run db:deploy` | Mevcut migration'ları uygular (veritabanını oluşturur). **`npm run dev` ve `npm start` bunu otomatik çalıştırır.** |
| `npm run db:migrate` | Şemayı değiştirdiyseniz: yeni migration oluşturur ve uygular (yalnızca geliştirmede). |
| `npm run db:generate` | Prisma istemcisini yeniden üretir (`npm install` zaten yapar). |
| `npm run db:studio` | Veritabanını tarayıcıda görüntüler (kullanıcılar, oturumlar, token'lar). |

Veritabanını **sıfırlamak** (tüm hesaplar silinir): sunucuyu durdurun, `data/dev.db` dosyasını silin, `npm run dev` ile yeniden başlatın.

> Proje OneDrive / Dropbox gibi eşitlenen bir klasördeyse SQLite dosyası eşitleme sırasında kilitlenebilir. Gerekirse `DATABASE_URL` ile eşitlenmeyen bir yol verin (ör. `file:C:/easyhustle-data/dev.db`).

---

## 5. Çalıştırma

| Komut | Ne yapar |
|---|---|
| `npm run dev` | **Yerel demo / geliştirme.** Migration'ları uygular, sunucuyu başlatır, kod değişince yeniden başlar. |
| `npm start` | Migration'ları uygular, sunucuyu başlatır (otomatik yeniden başlatma yok). |
| `npm run start:prod` | Canlı ortam modu (`NODE_ENV=production`; `APP_URL=https://...` gerekir). |
| `npm test` | Tüm testler (geçici veritabanlarıyla; çalışan sunucuya ihtiyaç duymaz). |
| `npm run health` | Çalışan sunucunun sağlık kontrolü. |

Başarılı açılışta konsolda şunlara benzer satırlar görünür:

```
EasyHustle → http://localhost:3000  (development)
Sağlık kontrolü: http://localhost:3000/api/health
Mod: DEMO (kural tabanlı) — AI için .env dosyasına ANTHROPIC_API_KEY ekleyin.
Veritabanı: file:.../data/dev.db
E-posta: geliştirme modu (gönderilmez, konsola yazılır) — göndermek için .env dosyasına RESEND_API_KEY ekleyin.
```

Tarayıcıda **http://localhost:3000** adresini açın. Sunucuyu durdurmak için konsolda `Ctrl+C`.

---

## 6. Resend kurulumu (gerçek e-posta için)

### 6.1 Hesap ve API anahtarı

1. https://resend.com adresinde ücretsiz hesap açın ve e-posta adresinizi doğrulayın.
2. **API Keys → Create API Key**
   - Name: `easyhustle-local` (istediğiniz ad)
   - Permission: **Sending access** (yalnızca gönderim — tam erişim vermeyin)
   - Domain: alan adı doğruladıysanız onunla sınırlayın
3. Oluşan anahtar (`re_...`) **yalnızca bir kez** gösterilir. `.env` dosyasına yazın:
   ```
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
   ```
   Anahtarı koda, ekran görüntülerine, sohbetlere veya git'e koymayın. Sızdığından şüphelenirseniz Resend panelinden silip yenisini oluşturun.

### 6.2 Hızlı deneme (alan adı olmadan)

`MAIL_FROM` boş bırakılırsa gönderen `EasyHustle <onboarding@resend.dev>` olur. Bu test göndericisi **yalnızca Resend hesabınızı açtığınız e-posta adresine** gönderebilir. Demo için bu adresle kayıt olun; başka adreslere gönderim Resend tarafından reddedilir (uygulama bu durumda "gönderilemedi" der, "gönderildi" demez).

### 6.3 Kendi alan adınızı doğrulama (herkese gönderim için)

1. Resend → **Domains → Add Domain** → alan adınızı yazın (öneri: alt alan adı, ör. `mail.alanadiniz.com`). Bölge olarak kullanıcılarınıza yakın olanı seçin.
2. Resend'in gösterdiği DNS kayıtlarını alan adınızın DNS paneline (Cloudflare, GoDaddy, Natro vb.) **birebir** ekleyin:
   - **DKIM** — `TXT` kaydı (`resend._domainkey...`): e-postaların sizin adınıza imzalanması
   - **SPF** — `TXT` kaydı (`v=spf1 include:...`) ve geri dönüşler için **MX** kaydı (gönderim alt alan adında)
   - **DMARC** (önerilir) — `_dmarc` adında `TXT` kaydı, ör. `v=DMARC1; p=none;`
3. Resend'de **Verify DNS Records** deyin. DNS yayılması birkaç dakikadan birkaç saate kadar sürebilir; durum **Verified** olunca hazırsınız.
4. `.env`:
   ```
   MAIL_FROM="EasyHustle <no-reply@mail.alanadiniz.com>"
   MAIL_REPLY_TO=destek@alanadiniz.com
   ```
5. Sunucuyu yeniden başlatın. Konsolda `E-posta: Resend ile gönderiliyor (gönderen: ...)` görünmelidir.

> Ücretsiz planın günlük / aylık gönderim limitleri vardır; güncel limitler için Resend fiyatlandırma sayfasına bakın. Gönderim geçmişi ve hatalar Resend panelinde **Emails / Logs** altında görünür.

### 6.4 Alan adı olmadan herkese gönderim: Brevo

Alan adınız yoksa Brevo, doğruladığınız tek bir e-posta adresinden (ör. Gmail) herkese gönderim yapabilir. HTTPS API kullandığı için SMTP'yi engelleyen platformlarda (Railway Trial/Hobby) da çalışır. `BREVO_API_KEY` tanımlıysa Resend yerine Brevo kullanılır.

1. https://www.brevo.com → ücretsiz hesap açın (ücretsiz planda günde 300 e-posta).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender** → gönderen adı `EasyHustle`, e-posta: kendi Gmail adresiniz. Brevo'nun bu adrese gönderdiği onay e-postasındaki bağlantıya tıklayın.
3. **SMTP & API → API Keys → Generate a new API key** → `xkeysib-` ile başlayan anahtarı kopyalayın (**gizli**; SMTP anahtarı `xsmtpsib-` değil, API anahtarı gerekir).
4. `.env` dosyasına (ve canlıda Railway → Variables'a) **kendiniz** yazın:
   ```
   BREVO_API_KEY=xkeysib-xxxxxxxx
   MAIL_FROM="EasyHustle <adiniz@gmail.com>"
   ```
   `MAIL_FROM`, 2. adımda doğruladığınız adresle **aynı** olmalıdır (Brevo ile zorunlu).
5. Sunucuyu yeniden başlatın. Konsolda `E-posta: Brevo ile gönderiliyor (gönderen: ...)` görünmelidir.

> Alan adı doğrulaması olmadan Gmail adresiyle gönderilen e-postalar bazı alıcılarda **spam** klasörüne düşebilir; kullanıcılara spam klasörüne bakmalarını söyleyin. Gönderim geçmişi Brevo → **Transactional → Logs** altındadır. Brevo bazı yeni hesaplarda gönderimi açmadan önce kısa bir hesap onayı isteyebilir.

---

## 7. E-posta doğrulamayı test etme

### A) Resend olmadan (varsayılan, yerel demo)

1. `npm run dev` ile başlatın, http://localhost:3000 adresini açın.
2. **Kayıt olun** → ad soyad, e-posta (gerçek olması gerekmez, ör. `demo@example.test`), güçlü bir şifre.
3. Pencere "**Geliştirme modu:** … doğrulama bağlantısı sunucu konsoluna yazıldı" der; sayfada sarı "e-posta adresiniz doğrulanmadı" uyarısı görünür.
4. Sunucu konsolunda şu bloğu bulun:
   ```
   [e-posta · geliştirme modu, GÖNDERİLMEDİ]
   Kime: demo@example.test
   ...
   http://localhost:3000/#verify=XXXXXXXX...
   ```
5. Bu bağlantıyı **aynı tarayıcıda** açın → "E-posta adresiniz doğrulandı" bildirimi, sarı uyarı kaybolur.
6. Aynı bağlantıyı tekrar açın → "geçersiz, süresi dolmuş veya daha önce kullanılmış" mesajı (tek kullanımlık).

### B) Resend ile (gerçek e-posta)

1. §6'daki gibi `RESEND_API_KEY` (ve alan adınız varsa `MAIL_FROM`) ayarlayıp sunucuyu yeniden başlatın.
2. Gelen kutunuza erişebildiğiniz bir adresle kayıt olun (alan adı doğrulamadıysanız: Resend hesabınızın adresi).
3. Pencere "**…adresine bir doğrulama bağlantısı gönderdik**" der. E-postadaki **E-posta adresimi doğrula** butonuna tıklayın (gelmezse spam klasörü).
4. E-posta gelmediyse: Resend → **Emails** sayfasında gönderimin durumuna bakın; uyarıdaki **Doğrulama e-postasını tekrar gönder** ile yenisini isteyin (60 sn bekleme, saatte en fazla 5). Yeni bağlantı gelince eskisi geçersiz olur.

> E-postadaki bağlantı `APP_URL` ile oluşturulur. Telefonda açacaksanız `localhost` çalışmaz; bağlantıyı bilgisayardaki tarayıcıda açın.

---

## 8. Demo akışı (önerilen sıra)

1. **Kayıt** — Önce zayıf bir şifre deneyin (`12345678`) → alan altında açıklama. Sonra güçlü şifreyle kayıt → doğrulama penceresi.
2. **Doğrulama** — §7'deki bağlantıyı açın → uyarı kaybolur.
3. **Uygulamayı kullanma** — Soldan bir örnek talep seçin → *Talebi analiz et* → *E-posta taslağı oluştur* → *Teklifi kaydet* (sol panelde "Kayıtlı teklifler").
4. **Çıkış** — Sağ üstte *Çıkış yap* → "Çıkış yaptınız." mesajıyla giriş penceresi.
5. **Hatalı giriş** — Yanlış şifre → "E-posta veya şifre hatalı."
6. **Giriş** — Doğru şifre → "Hoş geldiniz" ve kayıtlı teklifiniz yerinde.
7. **Aynı e-postayla kayıt** — Çıkış yapıp aynı e-postayla kayıt olmayı deneyin → "Bu e-postayla giriş yapın" bağlantısı.

---

## 9. Gizli bilgiler ve Git

`.gitignore` şunları dışarıda tutar: `.env`, `data/` (veritabanı), `src/generated/` (üretilen istemci), `node_modules/`, `test/.tmp/`, `*.log`.

Commit'ten önce kontrol:

```bash
git status --short
```

```bash
git check-ignore -v .env data/dev.db
```

`.env` veya `data/` **listede görünmemeli** (`git status`), `check-ignore` ise ikisini de göstermelidir. Repoda yalnızca `.env.example` bulunur ve içinde gerçek değer yoktur. Bir anahtar yanlışlıkla commit'lendiyse geçmişten silmek yetmez: **anahtarı sağlayıcıda iptal edip yenisini oluşturun.**

Her commit / push öncesi gizli bilgi taraması:

```bash
npm run check:secrets
```

Repoya girecek tüm dosyaları (`.gitignore` uygulanarak) ve Git geçmişini bilinen anahtar desenlerine (Resend, Anthropic, OpenAI, AWS, GitHub, Stripe, Slack, Google, özel anahtarlar, JWT, şifreli bağlantı adresleri) ve **yerel `.env` dosyanızdaki gerçek değerlere** karşı tarar. Bulunan değerleri yazdırmaz; bulgu varsa çıkış kodu 1'dir. `git add -f` ile yok sayılan bir dosyayı zorla eklemeyin.

GitHub'da repoyu oluşturduktan sonra **Settings → Code security → Secret scanning** ve **Push protection** özelliklerini açmanız önerilir.

---

## 10. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `does not provide an export named 'argon2'` veya `.ts` dosyası yüklenemiyor | Node.js sürümü eski: 24.7+ kurun (`node --version`). |
| `Port 3000 kullanımda` | `.env` içinde `PORT=3001` (ve `APP_URL`'i de buna göre) ayarlayın veya diğer işlemi kapatın. |
| `Veritabanı tabloları oluşturulmamış` | `npm run db:deploy` çalıştırın. |
| `Geçersiz ortam değişkenleri (.env)` | Mesajdaki değişkeni düzeltin (ör. `RESEND_API_KEY` `re_` ile başlamalı). |
| Kayıt "doğrulama e-postası gönderilemedi" diyor | Resend panelinde hata: çoğunlukla doğrulanmamış alan adı veya `onboarding@resend.dev` ile başka adrese gönderim. |
| "Çok fazla deneme" (429) | Hız sınırı; mesajdaki süre kadar bekleyin veya sunucuyu yeniden başlatın (sınırlar bellekte tutulur). |
| `EPERM` / veritabanı kilitli | Eşitlenen klasör (OneDrive) kilitliyor olabilir; §4'teki not. |

---

## 11. Canlıya alma (Railway)

Repo, Railway'in doğrudan kullanacağı dosyaları içerir: `Dockerfile` (Node 24, üretim imajı), `.dockerignore` (gizli dosyalar imaja girmez), `railway.json` (Dockerfile ile derleme, `/api/health` sağlık kontrolü). Her `main` push'unda Railway otomatik yeniden yayınlar; açılışta bekleyen migration'lar uygulanır (`npm run start:prod`).

1. https://railway.com → **Login → GitHub ile giriş**.
2. **New Project → Deploy from GitHub repo** → Railway'in GitHub uygulamasına `EasyHustle` reposuna erişim izni verin → repoyu seçin. İlk derleme başlar (sağlık kontrolü, değişkenler girilene kadar başarısız olabilir — normal).
3. Servis → **Settings → Networking → Generate Domain**. Port sorulursa günlükteki `EasyHustle → http://localhost:XXXX` satırındaki portu yazın (Railway `PORT` değişkenini kendisi verir). Oluşan adres: `https://<ad>.up.railway.app`.
4. Kalıcı veritabanı: proje tuvalinde **+ Create → Volume** → bu servise bağlayın, **Mount path: `/data`**. (Volume olmadan her yeniden yayında hesaplar silinir.)
5. Servis → **Variables** → şu değişkenleri ekleyin:

   | Değişken | Değer |
   |---|---|
   | `APP_URL` | `https://<ad>.up.railway.app` (3. adımdaki adres, sonda `/` olmadan) |
   | `DATABASE_URL` | `file:/data/easyhustle.db` |
   | `TRUST_PROXY` | `true` |
   | `BREVO_API_KEY` | Brevo API anahtarınız (`xkeysib-...`, §6.4) — **kendiniz yapıştırın**, başka yere yazmayın |
   | `MAIL_FROM` | Brevo ile: `EasyHustle <brevoda-dogrulanan@gmail.com>`. Resend ile: `EasyHustle <onboarding@resend.dev>` veya doğrulanmış alan adınızdan bir adres |
   | `RESEND_API_KEY` | *(Brevo yerine Resend kullanacaksanız)* Resend anahtarınız (`re_...`) |

   `NODE_ENV` ve `PORT` gerekmez (imaj `production` ile başlar, portu Railway verir).
6. **Deploy** → **Deployments → View logs**: `All migrations have been successfully applied`, `EasyHustle → … (production)` ve `E-posta: Brevo ile gönderiliyor` (veya `Resend ile`) satırlarını görmelisiniz.
7. Kontrol: `https://<ad>.up.railway.app/api/health` → `{"status":"ok", … "database":"ok"}`.

> **E-posta sınırı:** `onboarding@resend.dev` yalnızca Resend hesabınızın sahibine gönderir. Alan adı olmadan herkese göndermek için Brevo kullanın (§6.4); alan adınız varsa §6.3'teki gibi Resend'de doğrulayın. Railway Trial/Hobby planları SMTP portlarını engellediğinden Gmail SMTP canlıda çalışmaz; Brevo ve Resend HTTPS kullandığı için etkilenmez.
>
> **Maliyet:** Railway deneme kredisiyle başlar; sonrasında kullanım bazlı ücretlidir (güncel fiyatlar Railway sitesinde). Servisi durdurmak için proje → Settings → **Delete / Remove**.

---

## 12. Temiz ortamdan demo kontrol listesi

- [ ] `node --version` → **v24.7** veya üstü
- [ ] Projeyi klonla / kopyala ve klasöre gir
- [ ] `npm install` (hatasız bitmeli; "Generated Prisma Client" satırı görünür)
- [ ] `.env.example` → `.env` kopyala
- [ ] *(İsteğe bağlı)* `.env` içine `RESEND_API_KEY` (ve doğrulanmış alan adın varsa `MAIL_FROM`) yaz
- [ ] `npm test` → tüm testler **pass**
- [ ] `npm run dev` → konsolda `http://localhost:3000` ve e-posta modu satırı
- [ ] Ayrı bir terminalde `npm run health` → `200 {"status":"ok", ... "database":"ok"}`
- [ ] Tarayıcıda http://localhost:3000 → giriş penceresi açılır
- [ ] Kayıt ol → "E-posta adresinizi doğrulayın" penceresi + sarı uyarı
- [ ] Doğrulama bağlantısını aç (konsoldan veya gelen kutusundan) → "E-posta adresiniz doğrulandı"
- [ ] Bir talebi analiz et → taslak oluştur → kaydet
- [ ] Çıkış yap → "Çıkış yaptınız."
- [ ] Yanlış şifreyle giriş → hata; doğru şifreyle giriş → "Hoş geldiniz", kayıtlı teklif yerinde
- [ ] `git status` → `.env` ve `data/` listede **yok**
