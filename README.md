# Çanta Stok Yönetim Sistemi

Kadın çantası satan e-ticaret işletmeleri için geliştirilen tam kapsamlı stok yönetim sistemi.

## Proje Hakkında

Bu uygulama; ürün envanter takibi, günlük stok giriş/çıkış kayıtları, stok sayım yönetimi, Trendyol ve Hepsiburada fiyat/komisyon takibi, Excel raporlama ve çoklu kullanıcı desteği sunar.

**Teknolojiler:** Node.js, Express.js, PostgreSQL, Chart.js

**Özellikler:**
- Ürün envanter yönetimi (ekleme, düzenleme, silme, görsel yükleme)
- Günlük stok giriş/çıkış takibi
- Stok sayım (admin yetkili)
- Trendyol & Hepsiburada fiyat ve komisyon takibi
- Kritik ve tükenen stok uyarıları
- Excel raporlama (envanter, satış, kritik stoklar, stok değeri, sayım)
- 4 haneli PIN ile giriş, JWT tabanlı oturum yönetimi
- Kullanıcı rolleri: Admin ve Standart
- Sütun özelleştirme (göster/gizle, yeniden sırala, genişlik ayarla)
- JSON yedekleme

---

## Railway.app'te Deploy

### 1. Yeni Proje Oluştur
- [railway.app](https://railway.app) adresine gidin ve giriş yapın.
- "New Project" butonuna tıklayın.

### 2. PostgreSQL Eklentisi Ekle
- Proje içinde "New" > "Database" > "PostgreSQL" seçin.
- Veritabanı otomatik oluşturulacak ve `DATABASE_URL` ortam değişkeni eklenecek.

### 3. Ortam Değişkenleri Ayarla
Projenizin "Variables" sekmesine gidin ve şu değişkenleri ekleyin:

| Değişken | Açıklama |
|----------|----------|
| `DATABASE_URL` | PostgreSQL bağlantı URL'si (otomatik eklenir) |
| `JWT_SECRET` | Güçlü ve uzun bir gizli anahtar |
| `PORT` | 3000 (veya Railway'in atadığı port) |
| `UPLOAD_MAX_SIZE_MB` | 5 |

### 4. Kodu Deploy Et
- GitHub reponuzu Railway projesine bağlayın.
- Her push'ta Railway otomatik olarak deploy eder.
- `railway.json` dosyası yapılandırmayı içerir.

---

## Veritabanını Hazırla

Railway shell'den veya bağlı terminalde:

```bash
psql $DATABASE_URL -f db/schema.sql
```

Bu komut tüm tabloları oluşturur ve varsayılan ürün tiplerini ekler.

---

## İlk Admin Kullanıcısı

Veritabanı hazır olduktan sonra ilk admin kullanıcısını oluşturun:

```bash
npm run setup -- --username admin --pin 1234
```

Bu komut `admin` kullanıcısını `1234` PIN kodu ile oluşturur.

---

## Yerel Geliştirme

### Gereksinimler
- Node.js 18+
- PostgreSQL 14+

### Kurulum

```bash
# Bağımlılıkları yükle
npm install

# .env dosyası oluştur
cp .env.example .env
# .env dosyasını kendi veritabanı bilgilerinizle düzenleyin

# Veritabanı tablolarını oluştur
psql $DATABASE_URL -f db/schema.sql

# Admin kullanıcısı oluştur
npm run setup -- --username admin --pin 1234

# Uygulamayı başlat
npm start
```

Uygulama `http://localhost:3000` adresinde çalışacaktır.

---

## Yedekleme ve Geri Yükleme

### Yedek Alma
Ayarlar > Yedekleme sekmesinden "JSON Yedek İndir" butonunu kullanarak tüm verilerinizi indirin.

Yedek dosyası şu verileri içerir:
- Tüm ürünler
- Satış kayıtları
- Ürün tipleri
- Stok sayım oturumları ve kalemleri

Dosya adı formatı: `yedek_YYYY-MM-DD.json`

### Geri Yükleme
Şu an için geri yükleme manuel olarak veritabanı üzerinden yapılmalıdır.

---

## Sık Sorulan Sorular

**S: PIN kodumu unuttum, ne yapmalıyım?**
Admin kullanıcısı, Ayarlar > Kullanıcılar sekmesinden PIN'inizi sıfırlayabilir.

**S: Stok sayım nasıl çalışır?**
Yalnızca admin kullanıcılar stok sayım yapabilir. Yeni sayım başlatıldığında tüm ürünler mevcut stok miktarlarıyla listelenir. Gerçek sayım değerlerini girdikten sonra "Onayla ve Aktar" ile stoklar güncellenir.

**S: Birden fazla kullanıcı aynı anda kullanabilir mi?**
Evet. Her kullanıcının kendi giriş bilgileri ve sütun ayarları vardır.

**S: Hangi dosya formatları görsel olarak desteklenir?**
JPEG, PNG ve WebP formatları desteklenir. Maksimum dosya boyutu 5MB'tır.

**S: Excel raporları hangi bilgileri içerir?**
Tüm envanter, kritik stoklar, satış detayları, tarih aralığı satış özeti, ürün bazında stok değeri ve stok sayım raporları oluşturulabilir.

**S: Railway'de dosya yüklemeleri kalıcı mı?**
Railway'de dosya sistemi ephemeral'dır (yeniden deploy'da sıfırlanır). Kalıcı depolama için Cloudinary veya S3 gibi harici servisler kullanmanız önerilir.
