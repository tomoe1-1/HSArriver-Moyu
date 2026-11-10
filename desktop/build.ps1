param(
    [string]$WebView2Package,
    [string]$Python
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
if (-not $Python) { $Python = Join-Path $Root '.venv\Scripts\python.exe' }
if (-not (Test-Path $Python)) { throw 'Backend Python not found. Pass -Python <python.exe>.' }
& $Python (Join-Path $Root 'tools\build_web.py')
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

$Cache = Join-Path $env:LOCALAPPDATA 'Temp\opencode\hs-desktop-build'
if (-not $WebView2Package) { $WebView2Package = Join-Path $Cache 'webview2' }
$Version = '1.0.4314.35'
$Library = Join-Path $WebView2Package 'lib\net462'
if (-not (Test-Path (Join-Path $Library 'Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Force -Path $Cache | Out-Null
    $Zip = Join-Path $Cache 'webview2.zip'
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg" -OutFile $Zip -UseBasicParsing
    Expand-Archive -LiteralPath $Zip -DestinationPath $WebView2Package -Force
}
$Runtime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
Copy-Item (Join-Path $Library 'Microsoft.Web.WebView2.Core.dll') $Runtime -Force
Copy-Item (Join-Path $Library 'Microsoft.Web.WebView2.WinForms.dll') $Runtime -Force
Copy-Item (Join-Path $WebView2Package 'runtimes\win-x64\native\WebView2Loader.dll') $Runtime -Force
$License = Get-ChildItem $WebView2Package -File | Where-Object { $_.Name -match '^LICENSE' } | Select-Object -First 1
if ($License) { Copy-Item $License.FullName (Join-Path $Runtime 'WebView2.LICENSE.txt') -Force }

$Assets = Join-Path $PSScriptRoot 'assets'
New-Item -ItemType Directory -Force -Path $Assets | Out-Null
$Png = Join-Path $Assets 'brand.png'
if (-not (Test-Path $Png)) {
    & node (Join-Path $Root 'tools\render_desktop_icon.js')
    if ($LASTEXITCODE -ne 0) { throw 'Icon render failed. Install Playwright for build-time rendering.' }
}
& $Python -c "from PIL import Image; from pathlib import Path; p=Path(r'$Png'); Image.open(p).convert('RGBA').save(p.with_suffix('.ico'),sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
if ($LASTEXITCODE -ne 0) { throw 'Icon conversion failed.' }
$Compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $Compiler)) { throw '.NET Framework C# compiler not found.' }
$Exe = Join-Path $Root 'HSArriver.exe'
$Arguments = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    "/out:$Exe",
    "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')",
    "/win32icon:$(Join-Path $Assets 'brand.ico')",
    "/resource:$(Join-Path $Assets 'brand.ico'),HSArriver.Desktop.Icon",
    "/resource:$(Join-Path $Root 'web\assets\brand-icon.svg'),HSArriver.Desktop.Brand",
    "/resource:$(Join-Path $PSScriptRoot 'loading.html'),HSArriver.Desktop.Loading",
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.dll', '/reference:System.Web.Extensions.dll',
    "/reference:$(Join-Path $Runtime 'Microsoft.Web.WebView2.Core.dll')",
    "/reference:$(Join-Path $Runtime 'Microsoft.Web.WebView2.WinForms.dll')",
    (Join-Path $PSScriptRoot 'Program.cs'),
    (Join-Path $PSScriptRoot 'BackendSession.cs'),
    (Join-Path $PSScriptRoot 'ProcessIdentity.cs'),
    (Join-Path $PSScriptRoot 'MainWindow.cs')
)
& $Compiler @Arguments
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed.' }
Copy-Item (Join-Path $PSScriptRoot 'HSArriver.exe.config') "$Exe.config" -Force
Write-Output "Built: $Exe"
Write-Output 'Double-click to open the desktop app and start its backend. No Node or browser commands are needed.'
