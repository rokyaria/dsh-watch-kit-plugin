# dsh-watch-kit-plugin demo：目录大小监控（Windows / PowerShell 移植参考）
#
# ⚠️ 未在 Windows 上实测（仓库维护者无 Windows 环境）；仅作为移植参考。
# 契约：exit 0 = 无事件；exit 1 = 有事件；exit 255 = 异常。
# 注意：PowerShell 输出前必须设置 UTF-8，否则中文与 JSON 可能乱码。
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$dir = if ($env:WATCH_DEMO_DIR) { $env:WATCH_DEMO_DIR } else { Join-Path $HOME 'Downloads' }
$limitMb = if ($env:WATCH_DEMO_LIMIT_MB) { [int]$env:WATCH_DEMO_LIMIT_MB } else { 500 }
$state = $env:WATCH_STATE
if (-not $state) { [Console]::Error.WriteLine('WATCH_STATE is required'); exit 255 }

if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
  [Console]::Error.WriteLine("directory not found: $dir")
  exit 255
}

try {
  $sum = (Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction Stop |
          Measure-Object -Property Length -Sum).Sum
} catch {
  [Console]::Error.WriteLine("size failed for ${dir}: $_")
  exit 255
}
if ($null -eq $sum) { $sum = 0 }
$sizeKb = [math]::Round($sum / 1KB)
$limitKb = $limitMb * 1024
$marker = Join-Path $state 'above'

if ($sizeKb -gt $limitKb) {
  if (-not (Test-Path -LiteralPath $marker)) {
    Write-Output ("目录 {0} 当前 {1} MB，超过阈值 {2} MB" -f $dir, [math]::Round($sizeKb / 1024), $limitMb)
    New-Item -ItemType File -Path $marker -Force | Out-Null
    exit 1
  }
  exit 0
}

if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
exit 0
