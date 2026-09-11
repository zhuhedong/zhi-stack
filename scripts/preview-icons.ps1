$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$brandDirectory = Join-Path $projectRoot 'assets/brand'
$bitmap = [System.Drawing.Bitmap]::new(1120, 680)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F5F5F7'))
$ink = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#1D1D1F'))
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#68686F'))
$dark = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#202630'))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$title = [System.Drawing.Font]::new('Segoe UI', 44, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$body = [System.Drawing.Font]::new('Microsoft YaHei UI', 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$caption = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$large = [System.Drawing.Image]::FromFile((Join-Path $brandDirectory 'infohub-512.png'))
try {
    $graphics.DrawImage($large, 56, 102, 456, 456)
    $graphics.DrawString('InfoHub', $title, $ink, 576, 98)
    $graphics.DrawString('知识 · 项目 · 凭证', $body, $muted, 579, 164)
    $graphics.DrawString('iH 连字标记', $body, $ink, 579, 228)
    $graphics.DrawString('信息点与连接横梁，共用一个轮廓。', $body, $muted, 579, 263)
    $graphics.DrawString('SMALL SIZES / ACTUAL PIXELS', $caption, $muted, 580, 334)
    $position = 584
    foreach ($size in @(16, 24, 32, 48, 64)) {
        $variant = if ($size -le 32) { 'small' } else { 'large' }
        $imagePath = Join-Path $projectRoot ".local/infohub-icons/$variant/${size}x${size}.png"
        $small = [System.Drawing.Image]::FromFile($imagePath)
        try { $graphics.DrawImageUnscaled($small, $position, 393 - [int]($size / 2)) } finally { $small.Dispose() }
        $graphics.DrawString("${size}px", $caption, $muted, $position, 439)
        $position += 86
    }
    $graphics.FillRectangle($white, 579, 501, 185, 108)
    $graphics.FillRectangle($dark, 785, 501, 185, 108)
    $graphics.DrawImage($large, 595, 515, 80, 80)
    $graphics.DrawImage($large, 801, 515, 80, 80)
    $graphics.DrawString('Light', $caption, $muted, 689, 547)
    $graphics.DrawString('Dark', $caption, $white, 895, 547)
    $graphics.DrawString('APPLE BLUE  /  #007AFF', $caption, $muted, 102, 585)
    $bitmap.Save((Join-Path $brandDirectory 'preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $large.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    $ink.Dispose()
    $muted.Dispose()
    $dark.Dispose()
    $white.Dispose()
    $title.Dispose()
    $body.Dispose()
    $caption.Dispose()
}
Write-Output 'Saved assets/brand/preview.png'
