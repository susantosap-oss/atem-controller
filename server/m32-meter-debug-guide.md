# Cara Menjalankan M32 Meter Debug

Diagnostic logging dengan tag `[M32][meter-debug]` sudah ditambahkan ke `m32-manager.js` untuk menangkap data mentah `/meters/1`, `/meters/2`, dan nama FX Rtn — dipakai untuk verifikasi mapping AUX IN & FX Rtn (lihat issue #1/#2: phantom signal di AUX IN dan nama/sinyal FX Rtn yang salah).

## 1. Jalankan server mode standalone (supaya log terlihat)

```powershell
cd C:\Users\susan\atem-controller2026\server
npm run headless
```

Ini menjalankan `node src/socket-bridge.js` langsung — semua `console.log` (termasuk `[M32][meter-debug]`) tampil live di terminal.

> **Penting**: kalau biasanya pakai `npm start` (Electron app), log ini TIDAK akan terlihat karena window Electron tidak menampilkan stdout Node. Untuk sesi debug, wajib pakai `npm run headless`.

**Opsional** — simpan log ke file sekaligus tampil di layar:

```powershell
npm run headless | Tee-Object -FilePath m32-debug.log
```

## 2. Connect ke M32 dari App

Setelah server standalone jalan, buka App seperti biasa lalu connect ke M32 (masukkan IP & connect). Saat connect:

- `_queryNames()` jalan → muncul 4 baris:
  `[M32][meter-debug] /fxrtn/0X/config/name → raw="..."`
  (nama asli tiap FX Rtn dari device, untuk dicocokkan dengan tipe FX di console)
- `_pollMeters()` mulai → begitu data meter pertama masuk, muncul **satu kali** dump lengkap:
  - `[M32][meter-debug] /meters/1 (assumed: 32 input channels): blobLen=...`
  - `[M32][meter-debug] /meters/2 (ASSUMED: AuxIn1-8 then FxRtn1-4 — UNVERIFIED...): blobLen=...`
    berisi daftar nilai float per index `[0]`, `[1]`, ... beserta konversi dB-nya

## 3. Hal penting saat capture

- Log `/meters/1` & `/meters/2` **hanya muncul 1x per koneksi** (one-shot, dilacak via `_meterBlobLogged`, di-clear tiap `connect()`). Untuk capture ulang: disconnect lalu connect lagi dari App.
- **Sambil capture, catat kondisi real di console device M32** pada momen yang sama:
  - AUX IN 1-8: mana yang benar-benar "No Signal" vs ada sinyal
  - FX Rtn 1-4: nama FX asli (Plate/Hall/Delay/Insert) dan urutannya

## 4. Kirim hasil untuk dianalisis

Copy-paste seluruh blok log `[M32][meter-debug] /meters/2 ...` (semua baris index `[0]`...`[N]`) beserta catatan kondisi device pada saat itu. Data ini dipakai untuk menentukan index mana yang benar-benar berkorespondensi dengan AUX IN 1-8 dan FX Rtn 1-4, lalu memperbaiki mapping di `parseMeterBlob`.
