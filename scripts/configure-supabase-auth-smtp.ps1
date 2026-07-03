param(
  [string]$ProjectRef = "tykeycwworjtfpssjevw",
  [string]$AppUrl = "https://cro.idxparasuaempresa.com.br",
  [switch]$IncludeLocalDevRedirects,
  [string]$SmtpHost = $env:SMTP_HOST,
  [int]$SmtpPort = 587,
  [string]$SmtpUser = $env:SMTP_USER,
  [string]$SmtpPass = $env:SMTP_PASS,
  [string]$FromEmail = $env:SMTP_ADMIN_EMAIL,
  [string]$SenderName = $env:SMTP_SENDER_NAME
)

$ErrorActionPreference = "Stop"

$token = [Environment]::GetEnvironmentVariable("SUPABASE_ACCESS_TOKEN", "User")
if (-not $token) {
  $token = $env:SUPABASE_ACCESS_TOKEN
}

if (-not $token) {
  throw "SUPABASE_ACCESS_TOKEN nao encontrado no ambiente."
}

if ($env:SMTP_PORT) {
  $SmtpPort = [int]$env:SMTP_PORT
}

$missing = @()
if (-not $SmtpHost) { $missing += "SMTP_HOST" }
if (-not $SmtpUser) { $missing += "SMTP_USER" }
if (-not $SmtpPass) { $missing += "SMTP_PASS" }
if (-not $FromEmail) { $missing += "SMTP_ADMIN_EMAIL" }
if (-not $SenderName) { $missing += "SMTP_SENDER_NAME" }
if ($missing.Count -gt 0) {
  throw "Variaveis SMTP faltando: $($missing -join ', ')"
}

$uriAllowListItems = @("$AppUrl/**")
if ($IncludeLocalDevRedirects) {
  $uriAllowListItems += "http://127.0.0.1:5177/**"
  $uriAllowListItems += "http://localhost:5177/**"
}
$uriAllowList = $uriAllowListItems -join ","

$body = @{
  site_url = $AppUrl
  uri_allow_list = $uriAllowList
  external_email_enabled = $true
  mailer_autoconfirm = $false
  mailer_secure_email_change_enabled = $true
  smtp_admin_email = $FromEmail
  smtp_host = $SmtpHost
  smtp_port = $SmtpPort
  smtp_user = $SmtpUser
  smtp_pass = $SmtpPass
  smtp_sender_name = $SenderName
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Patch `
  -Uri "https://api.supabase.com/v1/projects/$ProjectRef/config/auth" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body $body | Out-Null

$config = Invoke-RestMethod `
  -Method Get `
  -Uri "https://api.supabase.com/v1/projects/$ProjectRef/config/auth" `
  -Headers @{ Authorization = "Bearer $token" }

[pscustomobject]@{
  site_url = $config.site_url
  uri_allow_list = $config.uri_allow_list
  external_email_enabled = $config.external_email_enabled
  mailer_autoconfirm = $config.mailer_autoconfirm
  smtp_configured = [bool]$config.smtp_host
  smtp_host = $config.smtp_host
  smtp_admin_email = $config.smtp_admin_email
  smtp_sender_name = $config.smtp_sender_name
} | ConvertTo-Json -Depth 4
