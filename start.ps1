# pi-wecom-envoy Windows 启动脚本
#
# 配置加载顺序（src/config.ts: loadConfig）：
#   1. ENVOY_CONFIG 环境变量指定的文件（若存在）
#   2. ./config.local.yaml（推荐；本地敏感配置，已 gitignore）
#   3. ./config.yaml（仓库默认；占位值，启动会因 botId/secret 缺失而报错）
#
# 用法：
#   .\start.ps1           # 用 tsx watch 启动（热重载）
#   .\start.ps1 -Prod     # 用 tsx 单次启动（生产模式）
#   .\start.ps1 -Typecheck
#   $env:ENVOY_CONFIG = 'D:\conf\prod.yaml'; .\start.ps1   # 覆盖

[CmdletBinding()]
param(
    [switch]$Prod,
    [switch]$Typecheck
)

$ErrorActionPreference = 'Stop'

Set-Location -Path $PSScriptRoot

if (-not (Test-Path node_modules)) {
    Write-Host "node_modules not found, running pnpm install..." -ForegroundColor Yellow
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
}

if ($Typecheck) {
    npx tsc -p tsconfig.json --noEmit
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
    Write-Host "typecheck OK" -ForegroundColor Green
    exit 0
}

if ($Prod) {
    npx tsx src/index.ts
} else {
    npx tsx watch src/index.ts
}