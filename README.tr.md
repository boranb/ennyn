# Ennyn

[English](README.md) · **Türkçe**

*Ennyn* (okunuşu *EN-nin*), Tolkien'in *Yüzüklerin Efendisi*'nde yalnız doğru sözle açılan Durin Kapıları'nın Sindarin dilindeki adıdır: "kapılar". Ennyn de tekrar eden her dersi, kodun geçmesi gereken bir kapıya çevirir.

Kodlama ajanları için kendini ölçen bir geliştirme döngüsü. Her döngü projenin iş grafiğinden dört görev alır: iki çekirdek görev, tekrar eden bir kusur sınıfını kapıya çeviren bir görev ve bitmiş bir özelliğin denetimi. Döngü, kusurların nereden geldiğini sayarak kapanır.

> Durum: yayın öncesi (0.0.x). Döngünün yaklaşık 700 oturum boyunca çalıştığı bir üretim projesinden çıkarıldı; aşağıdaki sayılar o projeden.

## Neden

Kaynak projenin 21 döngüsünü ölçtük (539 inceleme bulgusu, 398 ürün kusuru). Bu paketi üç sonuç şekillendirdi:

- **Yeni kusurların asıl kaynağı inceleme bulgularını düzeltmekti.** Düzeltmelerin açtığı ürün kusuru (99), ilk yazımın kaçırdığından (80) fazlaydı. İkinci ve sonraki turlardaki ciddi bulguların %66'sı önceki turun düzeltmesinin yan etkisiydi. Üçüncü ve sonraki turlar yeni bir kusur sınıfını yalnız iki kez buldu.
- **Riskli soruların çoğu zaten biliniyordu ama kod yazılmadan önce cevaplanmıyordu.** İnceleme istemleri bu soruları soruyordu; yazar ise onları ancak incelemeden sonra cevaplıyordu. İki bağımsız puanlayıcıya göre yeni ciddi kusurların neredeyse hepsi yazmadan önce en az kısmen sorulabilirdi.
- **Düzyazıyla yazılan dersler tekrarı durdurmadı, kapıya çevrilen dersler durdurdu.** Kapısı olan bir sınıf 11 döngü boyunca sıfırda kaldı. Yalnız yazılı kuralı olan bir sınıf 14 döngünün 13'ünde geri geldi. İş grafiğinde düğüme dönüşen önerilerin 11'de 8'i yapıldı; düğümü olmayanların 5'te 0'ı.

Sayılar, sınırları ve karşılaştırıldıkları yayımlanmış araştırmalar (İngilizce): [docs/evidence.md](docs/evidence.md).

## Ne yapar

| Adım | Döngü ne yapar | Araç |
|---|---|---|
| Kurulum | Önce depoyu okur: düzeltmeler nasıl etiketleniyor, commit'lerin çoğu hangi dosyaları yeniden yazıyor (üretilmiş çıktı), test düzeni, riskli yollar, yol haritası dosyaları ve issue'lar. Sonra en çok altı soru sorar; ayarı, başlangıç iş grafiğini ve bir devir taslağını yazar; `ennyn doctor` bunları denetler. | `/ennyn:init`, `ennyn init-scan`, `ennyn doctor` |
| Yazmadan önce | Beş satırlık etki tablosu, her satır bir komutla cevaplanır: bu kararı başka kim okuyor · bu duruma başka hangi yoldan varılıyor · hangi girdiler yeni kabul ya da ret ediliyor · tavanda ya da ölçüm başarısız olunca ne oluyor · sahteler nereden geliyor. Sezgisel kurallarda önce kabul ve ret örnekli bir derlem ile kırmızı bir test gelir. | `ennyn impact` |
| İnceleme | En çok iki tur; ikinci tur yalnız birinci turun düzeltmelerinin diff'ine bakar. Üçüncü tur ancak bağımsız bir sinyalle (test, kırma, gerçek ölçüm) açılır. Her bulgu bir alıntı, sınıf, kaynak, güven ve nasıl doğrulandığını taşır. | `agents/`, `skills/cycle/finding-schema.md` |
| Commit | Kısa konu ve gövde; inceleme turları ve etki özeti yapısal satırlar olarak yazılır. Bir commit-msg kancası her mesajı pahalı kanca koşmadan önce denetler. | `ennyn commit-check`, `ennyn install-hook` |
| Kapı denemeleri | Commit sarmalayıcısı her kapı denemesini (süre, sonuç, dosyalar, biliniyorsa düşen adım) makineye özel duruma kaydeder; özet bekleme süresini, başarısızlık oranını ve başarısız denemelerde geçen süreyi verir. Kayıt commit'in çıkış kodunu hiç değiştirmez. | `ennyn gate-record`, `ennyn gate-stats` |
| Üslup | Konuşma `focused` (önce sonuç ya da sıradaki adım, numaralı adımlar) ya da `terse` (önce cevap, kısa cümleler) olabilir; kurallar her oturumun başında verilir. Commit'ler `terse` olabilir: konu ve yapısal satırlar, düzyazı yok. Sayılar, yollar, komutlar, olumsuzluklar ve para ya da veri kaybı uyarıları hiç kısaltılmaz. | `conversation.style`, `commitMsg.style` |
| Yan kopyalar | Projenin worktree'si ya da düz kopyası, ana ağacın yükleyeceği yol kapsamlı kuralları alır. | Claude Code kancası |
| Döngü sonu | Dört sayılı yakınsama: gerçek kaçak, düzeltmenin açtığı, eski, kapının yakaladığı. En çok tekrar eden sınıf, `mechanization: true` işaretli bir iş grafiği düğümü olur. Bir ders dosyası budanır. Commit biçimi atlatmasının kullanımları sayılır; her oturum yüklenen talimat metni ölçülür, bu sayı yalnız küçülmelidir. Gönderilmemiş commit sayısıyla birlikte push onayı istenir. | `ennyn mechanization`, `ennyn push-check`, `ennyn rework`, `ennyn bypass`, `ennyn budget` |

`ennyn rework`, N gün içinde bir düzeltmenin satırlarını değiştirdiği commit'lerin oranını ölçer (bir SZZ türevi). Kaynak projede bağımsız bir Python uygulamasıyla aynı sonucu verdi: Eylül 46/306'ya 46/317, Ekim 30/135'e 33/141. Oran, projenin fix etiketi kadar iyidir: commit'lerin çoğu fix diye etiketlenmişse oran kusur onarımını değil değişim sıklığını sayar, araç da bunu söyler. `metrics.fixSubject`'i yalnız gerçek onarımlara uyacak biçimde ayarlayın; ayrıntı [docs/evidence.md](docs/evidence.md#speed-and-rework).

## Kurulum (Claude Code)

```sh
claude plugin marketplace add boranb/ennyn
claude plugin install ennyn@ennyn
```

Ardından projede: `/ennyn:init`.

Depo herkese açılmadan önce yerel bir kopyadan kurun: `claude plugin marketplace add ./ennyn`.

[Agent Skills](https://agentskills.io) biçimini okuyan başka ajanlar `skills/cycle/` dizinini doğrudan kullanabilir. CLI, Node 20 ya da üstünü ister ve bağımlılığı yoktur: `node scripts/ennyn.mjs --help`.

## Ayar

Her projede tek dosya: `.ennyn/config.json`; `/ennyn:init` yazar. Yalnız varsayılandan farklı olanı yazın. Bilinmeyen anahtarlar ve tür uyuşmazlıkları birlikte raporlanır; bir yazım hatası bir denetimi sessizce kapatamaz.

```json
{
  "language": "tr",
  "paths": { "graph": ".ennyn/graph.json" },
  "commitMsg": { "types": ["feat", "fix", "docs", "test", "refactor", "chore"], "fixType": "fix" },
  "review": { "impactRequiredGlobs": ["src/auth/**", "migrations/**"] },
  "impact": { "twins": [["src/lib/engine", "server/src/lib"]] }
}
```

Anahtarların tam tablosu [DESIGN.md](DESIGN.md)'de (İngilizce). Raporlar ve konuşma `language` ayarına uyar (`en` ya da `tr`); commit metni `commitMsg.language` ayarına uyar ve farklı olabilir (Türkçe konuşma, İngilizce commit). `commitMsg.types`, `commit-check`'in zorunlu tuttuğu konu türlerini belirler; `commitMsg.fixType` önceki commit'lerin onarımına ayrılmış tek türdür, böylece yeniden iş oranı değişim sıklığını değil onarımı sayar. İkisi de `/ennyn:init`'te seçilir ve projenin kendi talimatlarındaki commit kuralının yerine geçer.

İş grafiği, açık ve tamamlanmış düğümlerden oluşan iki dizili bir JSON dosyası (ya da ES modülü). Alan adları ayarlanabilir; mevcut bir grafik olduğu gibi kullanılabilir.

## Durum ve yol haritası

- **0.1**: çekirdek modüller, Claude Code eklentisi ve `/ennyn:init`: ayarı ve başlangıç grafiğini (bir yol haritası dosyasından, issue'lardan ya da kullanıcının kendi sözlerinden) yazan bir tarama ve kısa bir görüşme; `metrics.fixSubject` projenin kendi geçmişine göre seçilir.
- **0.2**: Codex manifesti, döngüyü eklentili ve eklentisiz karşılaştıran `claude plugin eval` vakaları ve döngünün ikinci bir projede ölçülmesi.
- **1.0**: kararlı ayar şeması.

## Lisans

MIT. Bkz. [LICENSE](LICENSE).

## Ad

Kod MIT lisanslıdır; adın kendi kısa politikası [TRADEMARK.md](TRADEMARK.md)'de (İngilizce). *Ennyn*, J.R.R. Tolkien'in kurgusal dillerinden bir sözcüktür. Bu proje Tolkien Estate, Middle-earth Enterprises ya da lisans sahipleriyle bağlantılı değildir; onlar tarafından desteklenmez ya da onaylanmaz.
