# Live verification of the deployed board.
#
# Why PowerShell: on this host curl (schannel) and Node (openssl) both fail the
# TLS handshake to this Cloudflare edge with "handshake failure" (alert 40),
# even for example.com. .NET's stack reaches the Worker fine, so verification
# uses Invoke-WebRequest instead of curl.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-live.ps1
#
# Reads the token from .board-token (gitignored) and never prints it.
# Exits non-zero if any check fails.
#
# NOTE: PowerShell functions return *everything* they write, so the checks must
# not return values — they stash the last response in $script:Last instead.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tok  = (Get-Content (Join-Path $root '.board-token') -Raw).Trim()
$base = 'https://rdu-gowild-board.sdotmo1223.workers.dev'

$script:Fail = 0
$script:Last = @{ code = 0; ct = ''; body = '' }

function Hit([string]$path) {
    try {
        $r = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -MaximumRedirection 0
        $script:Last = @{ code = [int]$r.StatusCode; ct = [string]$r.Headers['Content-Type']; body = [string]$r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            $script:Last = @{ code = 0; ct = ''; body = [string]$_.Exception.Message }
        } else {
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $script:Last = @{ code = [int]$resp.StatusCode; ct = [string]$resp.Headers['Content-Type']; body = $sr.ReadToEnd() }
        }
    }
}

function Check([string]$label, [string]$path, [int[]]$expect) {
    Hit $path
    $code = $script:Last.code
    $ok = $expect -contains $code
    if (-not $ok) { $script:Fail++ }
    $tag = if ($ok) { 'PASS' } else { 'FAIL' }
    $ct  = if ($script:Last.ct) { ' ' + ($script:Last.ct -split ';')[0] } else { '' }
    Write-Host ("[{0}] {1,-24} {2,4}{3}" -f $tag, $label, $code, $ct)
}

Write-Host '=== routes ==='
Check 'bare root /'        '/'                                    @(404)
Check 'wrong token'        '/s/definitely-not-token'              @(404)
Check 'no token /s/'       '/s/'                                  @(404)
Check 'right token = board' ('/s/' + $tok)                        @(200)
$pageHtml = $script:Last.body
Check 'api/board'          '/api/board'                           @(200, 401, 404)
$apiBody = $script:Last.body
Check 'sw.js (token-scoped)'       ('/s/' + $tok + '/sw.js')             @(200)
Check 'manifest (token-scoped)'    ('/s/' + $tok + '/manifest.webmanifest') @(200)
Check 'icon.svg (token-scoped)'    ('/s/' + $tok + '/icon.svg')           @(200)
Check 'sw.js at wrong token'       ('/s/definitely-not-token/sw.js')      @(404)

Write-Host ''
Write-Host '=== served board page ==='
if ($pageHtml.Length -gt 0) {
    [System.IO.File]::WriteAllText((Join-Path $root 'board.live.html'), $pageHtml)
    Write-Host ("bytes: {0}" -f $pageHtml.Length)
    Write-Host ("script tags: {0}" -f ([regex]::Matches($pageHtml, '<script').Count))
    $text = ($pageHtml -replace '<[^>]*>', ' ') -replace '\s+', ' '
    Write-Host ('human text: ' + $text.Substring(0, [Math]::Min(420, $text.Length)))

    Write-Host ''
    Write-Host '=== forbidden strings (all must be 0) ==='
    foreach ($bad in @('$NaN', '$undefined', '$0.01', '>undefined<', '>-1<')) {
        $n = ([regex]::Matches($pageHtml, [regex]::Escape($bad))).Count
        if ($n -ne 0) { $script:Fail++ }
        Write-Host ("  {0,-12} {1}" -f $bad, $n)
    }

    Write-Host ''
    Write-Host '=== is the client script really in the served page? ==='
    $hasPin = $pageHtml -match 'gowild\.pins'
    $hasIcs = $pageHtml -match 'text/calendar'
    if (-not $hasPin) { $script:Fail++ }
    if (-not $hasIcs) { $script:Fail++ }
    Write-Host ("  pin code present:   {0}" -f $hasPin)
    Write-Host ("  ICS code present:   {0}" -f $hasIcs)

    Write-Host ''
    Write-Host '=== empty-state honesty (KV still empty) ==='
    foreach ($w in @('No data', 'no data', 'not yet', 'Waiting', 'waiting', 'empty', 'snapshot')) {
        $n = ([regex]::Matches($pageHtml, [regex]::Escape($w))).Count
        if ($n -gt 0) { Write-Host ("  {0}: {1}" -f $w, $n) }
    }
}

Write-Host ''
Write-Host '=== api/board body ==='
Write-Host $apiBody

Write-Host ''
Write-Host ("RESULT: {0} failed check(s)" -f $script:Fail)
exit ([int]($script:Fail -gt 0))
