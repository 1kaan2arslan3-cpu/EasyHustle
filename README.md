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

| Mod | Ne zaman | Analiz / e-posta |
|---|---|---|
| **AI** | Sunucu çalışıyor ve `ANTHROPIC_API_KEY` tanımlı | Claude (varsayılan `claude-opus-5-5`) |
| **Demo** | Sunucu çalışıyor, anahtar yok | Kural tabanlı motor + şablon |
| **Statik demo** | GitHub Pages (sunucu yok) | Tarayıcıda kural tabanlı motor + şablon |

## Yerelde çalıştırma (localhost)

Gereksinim: Node.js 20+

```bash
npm install
```

```bash
cp .env.example .env
```

`.env` içine API anahtarınızı yazın (boş bırakırsanız demo modunda çalışır), sonra:

```bash
npm start
```

Tarayıcıda: http://localhost:3000

Geliştirirken dosya değişikliklerinde otomatik yeniden başlatma için `npm run dev`, testler için `npm test`.

## GitHub'da demo yayınlama

1. GitHub'da yeni bir repo oluşturun ve bu projeyi `main` dalına gönderin.
2. Repo → **Settings → Pages → Source: GitHub Actions** seçin.
3. Her `main` push'unda `.github/workflows/pages.yml` testleri çalıştırır ve `public/` klasörünü yayınlar.

Pages sürümü sunucusuz çalıştığı için **API anahtarı içermez**; kural tabanlı statik demo olarak çalışır. AI'lı sürüm için sunucuyu (`server.js`) bir Node barındırma servisinde çalıştırmak gerekir. **API anahtarını asla frontend koduna veya repoya koymayın.**

## Proje yapısı

```
server.js                    Express sunucusu + API uçları
src/ai.js                    Claude entegrasyonu (yapılandırılmış çıktı)
public/index.html            Arayüz
public/css/styles.css
public/js/app.js             Arayüz mantığı
public/js/quote.js           Teklif hesaplama (ortak)
public/js/demo-analyzer.js   Kural tabanlı analiz + e-posta şablonu (ortak)
public/data/catalog.json     Ürün kataloğu, fiyatlar, indirimler, Incoterm farkları
public/data/sample-requests.json  Örnek müşteri talepleri
test/                        Birim testleri (node --test)
```

### API

- `GET /api/status` → `{ mode: "ai" | "demo", model }`
- `POST /api/analyze` → gövde `{ from, subject, body }`, yanıt: analiz nesnesi
- `POST /api/draft-email` → gövde `{ request, analysis, quote, settings }`, yanıt `{ subject, body }`

AI çağrısı başarısız olursa sunucu otomatik olarak kural tabanlı sonuca döner ve yanıta `warning` ekler.

## Kendi firmanıza uyarlama

- Ürünler, fiyatlar, MOQ, termin, kademe indirimleri ve Incoterm farkları: `public/data/catalog.json`
- Firma adı, imza, teklif geçerliliği, varsayılan ödeme koşulu: arayüzde **Firma ayarları** (tarayıcıda saklanır)

## Yol haritası

- [ ] Müşteri diline otomatik çeviri (gönderim aşamasında)
- [ ] Gelen kutusu entegrasyonu (IMAP / Gmail / Outlook)
- [ ] Veritabanı ile teklif geçmişi ve durum takibi (taslak / gönderildi / kabul)
- [ ] PDF teklif çıktısı
- [ ] Döviz kuru ve navlun maliyeti entegrasyonu
