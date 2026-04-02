; ─────────────────────────────────────────────────────────────────────────────
; ATEM Controller — Custom NSIS Script
; Otomatis menambah / menghapus aturan Windows Firewall saat install/uninstall
; ─────────────────────────────────────────────────────────────────────────────

; ── Install ───────────────────────────────────────────────────────────────────
!macro customInstall
  DetailPrint "Menambahkan aturan Windows Firewall..."

  ; Port 4000 — Socket.io WebSocket Bridge (akses dari HP via WiFi)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule \
    name="ATEM Controller - WebSocket Bridge (4000)" \
    dir=in \
    action=allow \
    protocol=TCP \
    localport=4000 \
    profile=private \
    description="ATEM Controller remote WebSocket server — akses dari HP di LAN"'

  ; Port 3000 — Next.js PWA (opsional, jika serve dari PC yang sama)
  nsExec::ExecToLog 'netsh advfirewall firewall add rule \
    name="ATEM Controller - PWA Server (3000)" \
    dir=in \
    action=allow \
    protocol=TCP \
    localport=3000 \
    profile=private \
    description="ATEM Controller Next.js PWA server — akses dari browser HP"'

  ; Konfirmasi
  IfErrors firewall_error firewall_ok
  firewall_ok:
    DetailPrint "Firewall berhasil dikonfigurasi (port 3000 dan 4000 terbuka untuk jaringan privat)"
    Goto firewall_done
  firewall_error:
    DetailPrint "Peringatan: Gagal mengatur firewall. Buka port 3000 dan 4000 secara manual."
  firewall_done:
!macroend

; ── Uninstall ─────────────────────────────────────────────────────────────────
!macro customUnInstall
  DetailPrint "Menghapus aturan Windows Firewall..."

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule \
    name="ATEM Controller - WebSocket Bridge (4000)"'

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule \
    name="ATEM Controller - PWA Server (3000)"'

  DetailPrint "Aturan firewall dihapus."
!macroend
