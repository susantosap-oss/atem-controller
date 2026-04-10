@echo off
echo ========================================
echo  ATEM Controller - Build Windows .exe
echo ========================================
echo.

:: Pastikan npm tersedia
where npm >nul 2>&1 || (echo ERROR: npm tidak ditemukan. Install Node.js terlebih dahulu. & pause & exit /b 1)

:: Install dependencies jika belum ada atau electron-builder belum ter-install
if not exist "node_modules\.bin\electron-builder.cmd" (
  echo [1/3] Installing dependencies (including devDependencies)...
  call npm install
  if errorlevel 1 (echo GAGAL: npm install & pause & exit /b 1)
) else (
  echo [1/3] Dependencies sudah ada, skip install.
)

:: Pastikan icon ada
if not exist "assets\icon.ico" (
  echo.
  echo PERINGATAN: assets\icon.ico tidak ditemukan!
  echo Membuat icon placeholder...
  echo. > assets\icon.ico
  echo Harap ganti assets\icon.ico dengan icon 256x256 yang valid sebelum distribusi.
  echo.
)
if not exist "assets\icon.png" (
  echo. > assets\icon.png
)

:: Build
echo [2/3] Building .exe dengan electron-builder...
call npm run build
if errorlevel 1 (
  echo.
  echo GAGAL: Build error. Periksa log di atas.
  pause
  exit /b 1
)

echo.
echo [3/3] Build selesai!
echo Output: dist\ATEM Controller Setup 1.0.0.exe
echo.
echo Installer ini akan otomatis:
echo   - Membuka port 4000 di Windows Firewall (WebSocket Bridge)
echo   - Membuka port 3000 di Windows Firewall (PWA Server)
echo   - Membuat shortcut di Desktop dan Start Menu
echo.
pause
