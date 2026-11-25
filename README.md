# Backend hidroponik

Backend Node.js 20+ dengan broker MQTT terintegrasi untuk telemetri dan kontrol manual ESP32 melalui PostgreSQL. Proyek menggunakan tabel dan view yang sudah ada; tidak membuat atau memodifikasi skema.

## Konfigurasi

1. Pastikan database `DB_HIDROPONIK` dan skema yang disebutkan tersedia. Nama database PostgreSQL peka huruf besar/kecil jika dibuat dengan tanda kutip.
2. Salin `.env.example` menjadi `.env`. Isi `DATABASE_URL` dengan username dan password PostgreSQL Anda. Encode karakter khusus dalam username/password URL menggunakan percent-encoding.
3. Isi `MQTT_USERNAME` dan `MQTT_PASSWORD` dengan kredensial broker yang kuat. Keduanya wajib; backend menolak dijalankan jika kosong. Jangan bagikan `.env`.
4. Jalankan `npm install`, lalu `npm start` atau `npm run dev`. Uji dengan `npm test`.

### Dashboard web

Buka `http://localhost:3030` (atau port `PORT` yang dikonfigurasi) setelah backend berjalan. Dashboard memilih `hydro_tower_01` secara default; perangkat lain yang terdaftar dapat dipilih. Data diperbarui setiap 3 detik dan dapat dijeda. Status dan sensor berasal dari telemetri terakhir, bukan konfirmasi langsung perangkat; jika data gagal dimuat atau belum tersedia, status ditampilkan sebagai tidak diketahui.

Pada bagian riwayat perangkat, tabel **Aktivitas terakhir** menampilkan 10 log relay terbaru dan tabel **Log telemetri** menampilkan 100 catatan telemetri terbaru dari database untuk perangkat yang dipilih. Tabel mengikuti pengaturan pembaruan dashboard; geser horizontal untuk melihat semua kolom pada layar sempit.

Saat backend dimulai, log `[PostgreSQL] Diagnostics` menunjukkan database, pengguna, search path, alamat dan port server PostgreSQL, serta apakah `telemetry_logs` ditemukan pada search path dan schema `public`. URL koneksi dan password tidak dicetak. Untuk PM2, lihat dengan `pm2 logs <nama-atau-id>`. Jika pemeriksaan gagal, error ditampilkan di log; aplikasi tetap berjalan dan `/health` melaporkan status koneksi.

Untuk reverse proxy di subpath, buka dashboard dengan garis miring di akhir, misalnya `https://example.com/monitoring-tower/`. Contoh lokasi Nginx berikut meneruskan aset dan API dengan menghapus prefix sebelum mencapai backend:

```nginx
location = /monitoring-tower {
    return 308 /monitoring-tower/$is_args$args;
}

location /monitoring-tower/ {
    proxy_pass http://127.0.0.1:3030/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Garis miring terakhir pada `proxy_pass` diperlukan untuk menghapus prefix. Sesuaikan port dengan `PORT`; konfigurasi ini tidak menambahkan autentikasi, sehingga dashboard dan API tetap hanya boleh diakses melalui jaringan privat tepercaya.

Kontrol pompa menggunakan API yang sama. Durasi default pompa dosing adalah 5000 ms; durasi pompa air kosong mengikuti default firmware, yang dapat berarti tanpa batas otomatis. Tombol `Matikan Semua` mengirim `all_off: true`. Respons `202` hanya menandakan perintah dipublikasikan, bukan jaminan pompa berubah; periksa telemetri dan log. Dashboard tidak menambahkan autentikasi: hanya gunakan pada jaringan privat tepercaya.

Broker terintegrasi mendengarkan pada seluruh antarmuka IPv4 di port yang ditentukan oleh `MQTT_URL` (default 1883), sedangkan client internal terhubung melalui `127.0.0.1`. `MQTT_URL` hanya boleh berupa `mqtt://localhost:1883` atau `mqtt://127.0.0.1:1883`, dengan port yang dapat diubah. Pastikan port tersebut tidak digunakan proses lain.

Pada ESP32, atur `MQTT_HOST` ke alamat IPv4 komputer yang menjalankan backend, `MQTT_PORT` ke port yang sama, dan `MQTT_USER`/`MQTT_PASS` ke kredensial yang sama dengan `.env`. `localhost` pada ESP32 bukan komputer backend. Pastikan keduanya berada pada jaringan yang saling terhubung dan firewall mengizinkan koneksi masuk ke port broker. Broker mendukung MQTT 3.1/3.1.1 dan menggunakan penyimpanan dalam memori: retained messages dan sesi tidak bertahan setelah backend dimulai ulang.

Skema diharapkan menggunakan nilai teks `devices.device_id` pada kolom `device_id` tabel log dan view. Upsert telemetri memasukkan hanya `device_id`, `is_online`, dan `last_seen_at`; kolom `id` harus dibuat otomatis dan kolom perangkat lain harus nullable atau memiliki default agar upsert dapat berjalan. View `v_relay_run_history` harus memiliki kolom `device_id` dan `pump`. Kolom `recorded_at` log diisi waktu server database. Filter tanggal bersifat inklusif. Telemetri dan log relay diurutkan berdasarkan `recorded_at` menurun; urutan relay runs mengikuti hasil view dan tidak dijamin karena struktur tanggal view tidak ditentukan.

## API

Semua respons berhasil berupa JSON. Kesalahan validasi menghasilkan `400`, perangkat yang tidak terdaftar untuk perintah `404`, dan broker yang terputus `503`. Kesalahan database menghasilkan `500`; detail dicatat di server. `GET /health` memeriksa koneksi database dan MQTT dan menghasilkan `503` bila salah satunya terputus, tetapi tidak membuktikan perangkat online.

| Metode | Endpoint | Parameter |
| --- | --- | --- |
| GET | `/health` | - |
| GET | `/api/devices` | - |
| GET | `/api/devices/:deviceId/telemetry` | `limit`, `from`, `to` |
| GET | `/api/devices/:deviceId/relay-logs` | `limit`, `pump`, `action`, `from`, `to` |
| GET | `/api/devices/:deviceId/relay-runs` | `limit`, `pump` |
| POST | `/api/devices/:deviceId/cmd/relay` | JSON perintah di bawah |

`limit` default 100, maksimum 1000. `from` dan `to` menggunakan ISO 8601 lengkap dengan zona waktu, misalnya `2026-01-01T00:00:00Z` (encode `+` dalam URL). `deviceId` hanya boleh berisi huruf ASCII, angka, `_`, dan `-` (maksimum 128 karakter). Nilai `pump`: `pump_a`, `pump_b`, `ph_up`, `ph_down`, `pump_water`. Nilai `action`: `ON`, `OFF`, `BLOCKED`.

Contoh body perintah:

```json
{"pump":"pump_a","state":true,"duration_ms":5000}
```

```json
{"channel":5,"state":false}
```

```json
{"all_off":true}
```

Gunakan tepat satu dari `pump` atau `channel` (1–5); `state` boolean wajib. `duration_ms` opsional untuk `state: true`, berupa integer 0–4294967295 atau string angka yang dapat dikonversi menjadi integer dalam rentang tersebut. Nilainya diterbitkan sebagai angka tanpa perubahan; `null` dan string kosong ditolak. Firmware menentukan durasi default jika tidak disediakan; `0` dapat berarti tanpa batas otomatis. Backend tidak menjadwalkan perintah OFF setelah ON. Respons `202` hanya berarti pesan QoS 0 dikirim ke client MQTT, **bukan** konfirmasi perangkat menerima atau menjalankan perintah. Periksa event dan status perangkat untuk mengetahui hasilnya.

## Ingest dan keamanan

Topik `hydroponic/+/telemetry` dan `hydroponic/+/event` menerima JSON; `hydroponic/+/status` menerima teks `online` atau `offline`. Identitas perangkat diambil dari topik; `device_id` dalam JSON, jika ada, harus cocok. `water_level_cm` dan `distance_cm` negatif menjadi SQL `NULL`. Suhu yang tidak ada menjadi `NULL`. Untuk semua sensor, `-1`, `null`, `"NaN"`, dan angka non-finite menjadi `NULL`; JSON dengan token `NaN` mentah tidak valid dan ditolak.

Telemetri membuat atau memperbarui perangkat menjadi online dan memasukkan log dalam satu transaksi. Status mengubah `is_online` dan `last_seen_at` pada perangkat yang sudah ada; event juga memerlukan perangkat yang sudah ada. Jika status atau event tiba sebelum telemetri pertama untuk perangkat baru, pesan itu dicatat sebagai error dan tidak disimpan. Pesan per perangkat diproses sesuai urutan diterima; pesan tidak valid dan kesalahan database dicatat, tetapi tidak dicoba ulang.

Event `ON` memetakan `ph_before`, `ppm_before`, `water_before`, dan `water_temp_before` ke kolom referensi, dengan `is_active = true` dan `duration_ms = NULL`. Event `OFF` menggunakan field `*_after`, menyimpan `duration_ms`, dan mengatur `is_active = false`. Event `BLOCKED` menyimpan `is_active = false`, alasan, dan referensi `*_before` jika tersedia (atau `*_after` jika tidak ada). Nilai `false` pada `BLOCKED` adalah pemetaan event yang diminta, bukan bukti bahwa relay sebelumnya tidak aktif. `water_level_before`/`water_level_after` juga diterima sebagai alternatif. Firmware saat ini tidak mengirim suhu air, sehingga `water_temp_c` dan `water_temp_ref` akan `NULL` sampai firmware menambahkannya.

### Contoh payload MQTT

Topik `hydroponic/sim_hydro_test/telemetry`:

```json
{"device_id":"sim_hydro_test","mode":"MANUAL","uptime_ms":1000,"ph":6.2,"ph_mv":1750,"ppm":600,"ec":1200,"ec_mv":1800,"water_temp_c":25.5,"water_level_cm":35,"distance_cm":25,"relays":{"pump_a":false,"pump_b":false,"ph_up":false,"ph_down":false,"pump_water":false}}
```

Topik `hydroponic/sim_hydro_test/event`:

```json
{"device_id":"sim_hydro_test","mode":"MANUAL","channel":1,"pump":"pump_a","action":"ON","source":"MANUAL_MQTT","reason":"MQTT_MANUAL_ON","uptime_ms":2000,"ph_before":6.2,"ppm_before":600,"water_before":35,"water_temp_before":25.5}
```

```json
{"device_id":"sim_hydro_test","mode":"MANUAL","channel":1,"pump":"pump_a","action":"OFF","source":"MANUAL_MQTT","reason":"MQTT_MANUAL_OFF","uptime_ms":7000,"duration_ms":5000,"ph_after":6.3,"ppm_after":610,"water_after":34.9,"water_temp_after":25.5}
```

```json
{"device_id":"sim_hydro_test","mode":"MANUAL","channel":1,"pump":"pump_a","action":"BLOCKED","source":"MANUAL_MQTT","reason":"WATER_TOO_LOW_FOR_DOSING","uptime_ms":8000,"water_before":3}
```

Topik `hydroponic/sim_hydro_test/status` berisi teks biasa `online` atau `offline`, bukan JSON.

Untuk mengirim contoh tanpa hardware dari PowerShell di folder backend, jalankan backend terlebih dahulu dan isi kredensial MQTT di `.env`, lalu:

```powershell
@'
import 'dotenv/config';
import { once } from 'node:events';
import mqtt from 'mqtt';

const client = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  reconnectPeriod: 0,
});
const topic = 'hydroponic/sim_hydro_test';
const base = { device_id: 'sim_hydro_test', mode: 'MANUAL' };
const messages = [
  ['telemetry', { ...base, uptime_ms: 1000, ph: 6.2, ph_mv: 1750, ppm: 600, ec: 1200, ec_mv: 1800, water_temp_c: 25.5, water_level_cm: 35, distance_cm: 25, relays: { pump_a: false, pump_b: false, ph_up: false, ph_down: false, pump_water: false } }],
  ['status', 'online'],
  ['event', { ...base, channel: 1, pump: 'pump_a', action: 'ON', source: 'MANUAL_MQTT', reason: 'MQTT_MANUAL_ON', uptime_ms: 2000, ph_before: 6.2, ppm_before: 600, water_before: 35, water_temp_before: 25.5 }],
  ['event', { ...base, channel: 1, pump: 'pump_a', action: 'OFF', source: 'MANUAL_MQTT', reason: 'MQTT_MANUAL_OFF', uptime_ms: 7000, duration_ms: 5000, ph_after: 6.3, ppm_after: 610, water_after: 34.9, water_temp_after: 25.5 }],
  ['event', { ...base, channel: 1, pump: 'pump_a', action: 'BLOCKED', source: 'MANUAL_MQTT', reason: 'WATER_TOO_LOW_FOR_DOSING', uptime_ms: 8000, water_before: 3 }],
  ['status', 'offline'],
];
try {
  await once(client, 'connect');
  for (const [kind, data] of messages) {
    await client.publishAsync(`${topic}/${kind}`, typeof data === 'string' ? data : JSON.stringify(data), { qos: 1 });
    console.log(`Sent ${kind}`);
  }
} catch (error) {
  console.error('MQTT test failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.endAsync(true);
}
'@ | node --input-type=module -
```

Contoh ini membuat atau memperbarui `sim_hydro_test` dan menambahkan data uji ke database. Periksa log backend jika penyimpanan gagal; keberhasilan publish MQTT tidak menjamin insert database berhasil.

Jika ESP32 gagal terhubung, periksa alamat IP komputer backend, port, firewall, serta kecocokan username dan password. Jika backend gagal memulai broker dengan `EADDRINUSE`, hentikan atau pindahkan proses lain yang menggunakan port tersebut, atau ubah port pada backend dan ESP32.

Broker mewajibkan autentikasi tetapi **tidak menyediakan TLS atau ACL per perangkat**: setiap client yang mengetahui kredensial dapat membaca dan mengirim ke semua topik, termasuk perintah relay, dan kredensial dikirim tanpa enkripsi. Endpoint HTTP kontrol juga **tidak menyediakan autentikasi atau TLS**. Jangan mengekspos keduanya ke internet atau jaringan tidak tepercaya. Perintah pompa memiliki risiko operasional; pastikan batas durasi dan pengaman fisik pada firmware sesuai instalasi.
