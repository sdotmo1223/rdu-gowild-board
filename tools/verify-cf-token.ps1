# Check that CF_API_TOKEN can read the BOARD namespace WITHOUT printing the token
# or any KV value. This is the file the collector's 401/403 hint points at.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/verify-cf-token.ps1
$ErrorActionPreference = 'Stop'

function Get-DevVar([string]$Name) {
  if (Test-Path '.dev.vars') {
    foreach ($line in Get-Content '.dev.vars') {
      if ($line -match "^\s*$Name\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
    }
  }
  return $null
}

$token = if ($env:CF_API_TOKEN) { $env:CF_API_TOKEN } else { Get-DevVar 'CF_API_TOKEN' }
$account = if ($env:CF_ACCOUNT_ID) { $env:CF_ACCOUNT_ID } else { Get-DevVar 'CF_ACCOUNT_ID' }
$ns = if ($env:CF_KV_NAMESPACE_ID) { $env:CF_KV_NAMESPACE_ID } else { Get-DevVar 'CF_KV_NAMESPACE_ID' }

if (-not $token) { 'MISSING: CF_API_TOKEN is in neither the environment nor .dev.vars'; exit 2 }
if (-not $account -or -not $ns) { 'MISSING: CF_ACCOUNT_ID and CF_KV_NAMESPACE_ID are required too'; exit 2 }

$uri = "https://api.cloudflare.com/client/v4/accounts/$account/storage/kv/namespaces/$ns/keys"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 30
  $keys = @((($r.Content | ConvertFrom-Json).result))
  "HTTP $($r.StatusCode): the token can read namespace $ns ($($keys.Count) key(s): $($keys.name -join ', ')). Token was never printed."
  exit 0
} catch {
  $status = 0
  try { $status = [int]$_.Exception.Response.StatusCode } catch { }
  "HTTP $status: token rejected or namespace unreachable."
  if ($status -eq 401) { '401 = invalid or expired token for this account.' }
  if ($status -eq 403) { '403 = valid token, missing the Workers KV Storage: Edit permission.' }
  if ($status -eq 404) { '404 = the namespace id does not exist in this account.' }
  exit 1
}
