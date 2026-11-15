# build.ps1 - empaqueta el complemento como .xpi.
#
# Importante: las entradas del ZIP deben usar "/" (barra normal), no "\".
# Compress-Archive en Windows crea entradas con barra invertida y entonces
# Zotero/Firefox no encuentra chrome://refimport/content/... dentro del
# .xpi (el diálogo abre "file not found"). Por eso se construye el ZIP a
# mano con System.IO.Compression.ZipArchive.
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\build.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$addonDir = Join-Path $root "addon"
$distDir = Join-Path $root "dist"
$manifestPath = Join-Path $addonDir "manifest.json"

if (-not (Test-Path $manifestPath)) {
    throw "No se encontró $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json no tiene 'version'" }

New-Item -ItemType Directory -Force $distDir | Out-Null
$outPath = Join-Path $distDir ("refimport-" + $version + ".xpi")
if (Test-Path $outPath) { Remove-Item $outPath -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$fs = [System.IO.File]::Open($outPath, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $addonDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($addonDir.Length + 1).Replace('\', '/')
        $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $stream.Write($bytes, 0, $bytes.Length)
        }
        finally {
            $stream.Dispose()
        }
    }
}
finally {
    $zip.Dispose()
    $fs.Dispose()
}

$info = Get-Item $outPath
Write-Host ("XPI: " + $info.FullName)
Write-Host ("Versión: " + $version + "  Tamaño: " + $info.Length + " bytes")

# Comprobación rápida: todas las entradas con "/".
$z = [System.IO.Compression.ZipFile]::OpenRead($outPath)
try {
    $bad = @($z.Entries | Where-Object { $_.FullName.Contains('\') })
    if ($bad.Count -gt 0) {
        throw ("Entradas con barra invertida: " + ($bad.FullName -join ", "))
    }
    $z.Entries | Select-Object FullName, Length | Format-Table -AutoSize
}
finally {
    $z.Dispose()
}
