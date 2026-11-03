# Checks whether a Cloudflare API token will actually work for this board,
# WITHOUT ever printing the token.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-cf-token.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-cf-token.ps1 -Token $tok
#
# Order of preference: -Token, then $env:CF_API_TOKEN, then the clipboard.
# Copy the token first, then run this with no arguments.
#
# This exists because a workflow run failed with a bare "KV GET 401" after it had
# already spent 19 Frontier requests: the credential was wrong, not the code.

param([string]$Token)

$ErrorActionPreference = 'Continue'
$account = '7421588938f1e631161153856983ffb5'
$ns      = 'fec311a9eda84b90a8490061cda5d4bf'
$base    = 'https://api.cloudflare.com/client/v4'

if (-not $Token) { $Token = $env:CF_API_TOKEN }
if (-not $Token) {
    try { $Token = (Get-Clipboard -Raw) } catch { $Token = $null }
}
if (-not $Token) {
    Write-Host 'No token given: pass -Token, set $env:CF_API_TOKEN, or copy it to the clipboard.'
    exit 2
}
$Token = $Token.Trim()

# Shape check first: it stops the script from sending a URL or a token *id* and
# reporting a confusing auth error. Cloudflare tokens are 40 chars.
$shapeOk = ($Token.Length -eq 40) -and ($Token -match '^[A-Za-z0-9_-]+$')
Write-Host ("token shape: {0} chars, {1}" -f $Token.Length, $(if ($shapeOk) { 'looks like a CF token' } else { 'DOES NOT look like a CF token (40 alnum/_/- chars)' }))
if (-not $shapeOk) {
    Write-Host '  A token *id* is 32 hex chars; a board URL is ~82. Neither will authenticate.'
}
Write-Host ''

function Call([string]$method, [string]$url) {
    try {
        $r = Invoke-WebRequest -Uri $url -Method $method -UseBasicParsing `
             -Headers @{ Authorization = "Bearer $Token" } -ErrorAction Stop
        return @{ code = [int]$r.StatusCode; body = [string]$r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ code = 0; body = [string]$_.Exception.Message } }
        $code = [int]$resp.StatusCode
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        return @{ code = $code; body = $sr.ReadToEnd() }
    }
}

function ShowApiErrors([string]$body) {
    try {
        $j = $body | ConvertFrom-Json
        if ($j.errors) {
            foreach ($e in $j.errors) { Write-Host ("  error {0}: {1}" -f $e.code, $e.message) }
        }
    } catch { }
}

Write-Host '=== 1. is the token itself valid? (/user/tokens/verify) ==='
$v = Call 'GET' "$base/user/tokens/verify"
Write-Host ("  HTTP {0}" -f $v.code)
if ($v.code -eq 200) {
    Write-Host '  token is ACTIVE'
} else {
    ShowApiErrors $v.body
}
Write-Host ''

Write-Host '=== 2. can it read the board namespace? (KV GET) ==='
$k = Call 'GET' "$base/accounts/$account/storage/kv/namespaces/$ns/values/state"
Write-Host ("  HTTP {0}" -f $k.code)
switch ($k.code) {
    200 { Write-Host '  READ WORKS, and a snapshot exists (this is what the collector needs)' }
    404 { Write-Host '  READ WORKS (404 just means no snapshot yet - also fine)' }
    401 { Write-Host '  REJECTED: the token value is not accepted for this account.'; ShowApiErrors $k.body }
    403 { Write-Host '  TOKEN IS VALID but lacks Workers KV Storage: Edit on this account.'; ShowApiErrors $k.body }
    default { ShowApiErrors $k.body }
}
Write-Host ''

Write-Host '=== verdict ==='
if ($v.code -ne 200) {
    Write-Host '  FAIL: create a new token (My Profile -> API Tokens -> Create Token) with'
    Write-Host '        Workers KV Storage: Edit  +  Account Settings: Read, then re-set the secret.'
} elseif ($k.code -eq 200 -or $k.code -eq 404) {
    Write-Host '  PASS: this token can drive the collector. Set it as CF_API_TOKEN and re-enable the workflow.'
} else {
    Write-Host '  FAIL: token authenticates but cannot reach this KV namespace. Check the account id'
    Write-Host '        and that the token has Workers KV Storage: Edit for account 7421588938f1e631161153856983ffb5.'
}
