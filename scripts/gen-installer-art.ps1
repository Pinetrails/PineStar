# Generate the branded NSIS installer bitmaps (CRT phosphor look).
#
# NSIS (Modern UI) wants classic 24-bit BMPs at fixed sizes:
#   sidebar (welcome/finish page)  164 x 314
#   header  (inner pages)          150 x  57
# Output is committed under src-tauri/installer/ — re-run this only to change the art.
#   powershell -ExecutionPolicy Bypass -File scripts/gen-installer-art.ps1
#
# Windows-only (System.Drawing/GDI+); the BMPs it emits are consumed on every platform's
# NSIS build, which only happens on Windows anyway.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root   = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'src-tauri\installer'
New-Item -ItemType Directory -Force $outDir | Out-Null

# palette — StarNet CRT: near-black glass, phosphor green, gold accent
$C_BG0   = [System.Drawing.Color]::FromArgb(2, 6, 4)
$C_BG1   = [System.Drawing.Color]::FromArgb(6, 22, 16)
$C_PHOS  = [System.Drawing.Color]::FromArgb(88, 255, 155)
$C_PHOSD = [System.Drawing.Color]::FromArgb(24, 92, 56)    # dim phosphor (glow passes)
$C_GOLD  = [System.Drawing.Color]::FromArgb(212, 175, 96)
$C_GOLDD = [System.Drawing.Color]::FromArgb(96, 76, 40)

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  # vertical CRT-glass gradient
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $C_BG0, $C_BG1, 90.0)
  $g.FillRectangle($grad, $rect); $grad.Dispose()
  return @($bmp, $g)
}

function Add-Starfield($g, [int]$w, [int]$h, [int]$n, [int]$seed) {
  $rnd = New-Object System.Random($seed)   # seeded => regenerating gives identical art
  for ($i = 0; $i -lt $n; $i++) {
    $x = $rnd.Next(0, $w); $y = $rnd.Next(0, $h)
    $v = $rnd.Next(30, 110)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($v, [Math]::Min(255, $v + 40), $v))
    $g.FillRectangle($b, $x, $y, 1, 1); $b.Dispose()
  }
}

function Add-GlowText($g, [string]$text, $font, [single]$x, [single]$y, $core, $dim) {
  $bd = New-Object System.Drawing.SolidBrush($dim)
  foreach ($o in @(@(-1,0), @(1,0), @(0,-1), @(0,1), @(-1,-1), @(1,1))) {
    $g.DrawString($text, $font, $bd, ($x + $o[0]), ($y + $o[1]))
  }
  $bd.Dispose()
  $bc = New-Object System.Drawing.SolidBrush($core)
  $g.DrawString($text, $font, $bc, $x, $y); $bc.Dispose()
}

function Add-Scanlines($bmp) {
  # every 3rd row darkened — the CRT read; drawn LAST so it sits over everything
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 0, 0, 0), 1)
  for ($y = 0; $y -lt $bmp.Height; $y += 3) { $g.DrawLine($pen, 0, $y, $bmp.Width, $y) }
  $pen.Dispose(); $g.Dispose()
}

function Save-Bmp($bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  Write-Host "wrote $path ($($bmp.Width)x$($bmp.Height))"
}

# ---------- sidebar 164x314 (welcome/finish page) ----------
$bmp, $g = New-Canvas 164 314
Add-Starfield $g 164 314 90 1337

# phosphor glow well behind the wordmark
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(-60, 60, 280, 200)
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(60, 88, 255, 155)
$pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 2, 6, 4))
$g.FillPath($pgb, $path); $pgb.Dispose(); $path.Dispose()

# stacked wordmark, one letter per row — reads like a boot column
$fBig = New-Object System.Drawing.Font('Consolas', 26, [System.Drawing.FontStyle]::Bold)
$word = 'STARNET'
for ($i = 0; $i -lt $word.Length; $i++) {
  Add-GlowText $g $word[$i] $fBig 62 (52 + $i * 30) $C_PHOS $C_PHOSD
}
$fBig.Dispose()

# gold accent rail + status line at the foot
$penG = New-Object System.Drawing.Pen($C_GOLD, 1)
$g.DrawLine($penG, 20, 278, 144, 278); $penG.Dispose()
$fSm = New-Object System.Drawing.Font('Consolas', 8, [System.Drawing.FontStyle]::Bold)
Add-GlowText $g 'HARNESS // ONLINE' $fSm 26 286 $C_GOLD $C_GOLDD
$fSm.Dispose()

$g.Dispose()
Add-Scanlines $bmp
Save-Bmp $bmp (Join-Path $outDir 'sidebar.bmp')
$bmp.Dispose()

# ---------- header 150x57 (inner pages) ----------
$bmp, $g = New-Canvas 150 57
Add-Starfield $g 150 57 26 4242

$fHdr = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Bold)
Add-GlowText $g 'STARNET' $fHdr 10 14 $C_PHOS $C_PHOSD
$fHdr.Dispose()
$penG = New-Object System.Drawing.Pen($C_GOLD, 1)
$g.DrawLine($penG, 12, 42, 108, 42); $penG.Dispose()

$g.Dispose()
Add-Scanlines $bmp
Save-Bmp $bmp (Join-Path $outDir 'header.bmp')
$bmp.Dispose()
