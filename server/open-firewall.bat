@echo off
echo ========================================
echo  ATEM Controller - Open Windows Firewall
echo ========================================
echo.

:: Cek apakah dijalankan sebagai Administrator
net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: File ini harus dijalankan sebagai Administrator.
  echo Klik kanan file ini ^> "Run as administrator"
  echo.
  pause
  exit /b 1
)

echo Membuka port untuk ATEM Controller...
echo.

:: Hapus rule lama jika ada (untuk menghindari duplikat)
netsh advfirewall firewall delete rule name="ATEM Controller WebSocket" >nul 2>&1
netsh advfirewall firewall delete rule name="ATEM Controller PWA" >nul 2>&1
netsh advfirewall firewall delete rule name="ATEM Controller Node" >nul 2>&1

:: Buka port 4000 (WebSocket bridge)
echo [1/3] Membuka port 4000 (WebSocket)...
netsh advfirewall firewall add rule name="ATEM Controller WebSocket" dir=in action=allow protocol=TCP localport=4000
if errorlevel 1 (echo GAGAL membuka port 4000 & goto :error)

:: Buka port 3000 (PWA / Next.js)
echo [2/3] Membuka port 3000 (PWA)...
netsh advfirewall firewall add rule name="ATEM Controller PWA" dir=in action=allow protocol=TCP localport=3000
if errorlevel 1 (echo GAGAL membuka port 3000 & goto :error)

:: Izinkan node.exe secara langsung (mengatasi block pada executable)
echo [3/3] Mengizinkan node.exe...
for /f "delims=" %%i in ('where node 2^>nul') do (
  netsh advfirewall firewall add rule name="ATEM Controller Node" dir=in action=allow program="%%i" enable=yes
)

echo.
echo ========================================
echo  SELESAI! Firewall rules berhasil dibuat
echo ========================================
echo.
echo Port yang dibuka:
echo   - 3000  (PWA / Next.js)
echo   - 4000  (WebSocket Bridge)
echo.
echo Coba akses dari HP/device lain:
echo   PWA    : http://[IP-PC]:3000
echo   Socket : http://[IP-PC]:4000
echo.

:: Tampilkan IP lokal untuk memudahkan
echo IP Address PC ini:
ipconfig | findstr /i "IPv4"
echo.
pause
exit /b 0
:error
echo.
echo Terjadi kesalahan. Pastikan dijalankan sebagai Administrator.
echo.
pause
exit /b 1
