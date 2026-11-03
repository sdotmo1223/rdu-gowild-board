# Checks whether a Cloudflare API token will actually work for this board,
# WITHOUT ever printing the token.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-cf-token.ps1 -Prompt
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-cf-token.ps1 -Token $tok
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-cf-token.ps1 -Prompt -SetSecret
#
# -Prompt reads the token without echoing it (paste, Enter). Order otherwise:
# -Token, then $env:CF_API_TOKEN, then the clipboard.
# -SetSecret pipes a *validated* token straight into `gh secret set`, so the value
# never has to be pasted a second time and never appears in shell history.
#
# Why this exists: a workflow run burned 19 Frontier requests and then failed on
# a bare "KV GET 401". The code was fine; the pasted credential was not.

param(
    [string]$Token,
    [switch]$Prompt,
    [switch]$SetSecret
)

$ErrorActionPreference = 'Continue'
$account = '7421588938f1e631161153856983ffb5'
$ns      = 'fec311a9eda84b90a8490061cda5d4bf'
$base    = 'https://api.cloudflare.com/client/v4'
$repo    = 'sdotmo1223/rdu-gowild-board'

if ($Prompt) {
    $sec = Read-Host -AsSecureString -Prompt 'Paste the Cloudflare API token (input is hidden)'
    $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if (-not $Token) { $Token = $env:CF_API_TOKEN }
if (-not $Token) {
    try { $Token = (Get-Clipboard -Raw) } catch { $Token = $null }
}
if (-not $Token) {
    Write-Host 'No token given. Use -Prompt, pass -Token, set $env:CF_API_TOKEN, or copy it.'
    exit 2
}

# Cloudflare uses TWO token formats and both must be accepted verbatim:
#   cfut_<48>   new scannable user-scoped token (53 chars)  <- the current UI
#   cfat_<..>   account-owned token
#   <40 alnum>  legacy bare token value
# Never slice a fixed-width window out of a longer string: doing that to a 53-char
# cfut_ token sent a truncated credential, and Cloudflare answers 6003 "invalid
# request headers", which reads like a permissions bug (2026-11-03).
$raw = ([string]$Token).Trim().Trim('"').Trim("'")
$Token = $null
if ($raw -match '^(cf(?:ut|at)_[A-Za-z0-9_-]{20,80})$') {
    $Token = $Matches[1]
    Write-Host ("token shape: {0}-prefixed, {1} chars, exactly a Cloudflare token" -f $Token.Substring(0, 5), $Token.Length)
} elseif (($raw.Length -eq 40) -and ($raw -match '^[A-Za-z0-9_-]{40}$')) {
    $Token = $raw
    Write-Host 'token shape: legacy 40-char value, exactly a Cloudflare token'
} elseif ($raw -match '(cf(?:ut|at)_[A-Za-z0-9_-]{20,80})') {
    $Token = $Matches[1]
    Write-Host ("token shape: input was {0} chars; extracted the {1}-prefixed token ({2} chars) from it" -f $raw.Length, $Token.Substring(0, 5), $Token.Length)
} else {
    Write-Host ("token shape: input was {0} chars and contains no cfut_/cfat_ or legacy 40-char token." -f $raw.Length)
    Write-Host '  Nothing was sent to Cloudflare. A token ID is 32 hex chars; a board URL is ~82.'
    Write-Host '  Copy the token VALUE from My Profile -> API Tokens, or use -Prompt.'
    exit 3
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
if ($v.code -eq 200) { Write-Host '  token is ACTIVE' } else { ShowApiErrors $v.body }
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

$pass = ($v.code -eq 200) -and ($k.code -eq 200 -or $k.code -eq 404)

Write-Host '=== verdict ==='
if ($pass) {
    Write-Host '  PASS: this token can drive the collector.'
} elseif ($v.code -ne 200) {
    Write-Host '  FAIL: create a new token (My Profile -> API Tokens -> Create Token) with'
    Write-Host '        Workers KV Storage: Edit  +  Account Settings: Read, then try again.'
} else {
    Write-Host '  FAIL: token authenticates but cannot reach this KV namespace. Check that it'
    Write-Host "        has Workers KV Storage: Edit for account $account."
}

if ($SetSecret) {
    Write-Host ''
    if (-not $pass) {
        Write-Host '  -SetSecret ignored: not setting a token that failed verification.'
        exit 1
    }
    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh) {
        $fallback = 'C:\Program Files\GitHub CLI\gh.exe'
        if (Test-Path $fallback) { $gh = $fallback }
    }
    if (-not $gh) {
        Write-Host '  gh CLI not found; set the secret by hand.'
        exit 1
    }
    $Token | & $gh secret set CF_API_TOKEN --repo $repo
    if ($LASTEXITCODE -eq 0) { Write-Host '  CF_API_TOKEN set on the repo (value never printed).' }
    else { Write-Host "  gh failed with exit code $LASTEXITCODE" }
}

if ($pass) { exit 0 } else { exit 1 }
