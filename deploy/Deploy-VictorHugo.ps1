<#
.SYNOPSIS
  End-to-end PowerShell deploy of Victor Hugo to Oracle Cloud (Always Free).

.DESCRIPTION
  Uses the locally-installed `oci` CLI (configured with your tenancy
  credentials) to:
    1. Generate an SSH key if you don't have one
    2. Create the VCN, internet gateway, route table, security list, subnet
    3. Launch a VM (MICRO x86 or A1 ARM, both Always Free)
    4. Wait for the VM to be RUNNING and reachable on port 22
    5. SSH into the VM and run deploy/bootstrap.sh which installs Node,
       builds the app, sets up nginx, issues HTTPS via certbot, configures
       systemd + the backup cron.

  Idempotent: re-running reuses any matching network resource by name and
  skips ahead. Safe to interrupt and resume.

.PARAMETER Domain
  Public hostname leaders will type to log in. Required. Example:
  attendance.earth.ac.cr. You must point an A record at the VM's public
  IP yourself (the script prints when and how).

.PARAMETER AdminEmail
  Email for the Let's Encrypt certificate registration and certbot
  renewal notifications. Required.

.PARAMETER Shape
  MICRO (default) = VM.Standard.E2.1.Micro, 1 OCPU + 1 GB RAM x86 Always Free
  A1              = VM.Standard.A1.Flex, 2 OCPU + 12 GB RAM ARM Always Free

.PARAMETER LeaderAccessCode
  Shared password for the leader-role cohort. Auto-generated if you don't
  pass one (printed at the end so you can share with leaders).

.PARAMETER InstanceName
  Display name for the VM in the Oracle Cloud console. Default: victor-hugo.

.PARAMETER RepoUrl
  Public git URL the VM clones from. Defaults to the canonical repo.

.PARAMETER SkipProvision
  Skip VM creation. Use with -ExistingPublicIp to deploy onto an existing VM.

.PARAMETER ExistingPublicIp
  Use with -SkipProvision to point at an already-running VM by IP.

.EXAMPLE
  .\Deploy-VictorHugo.ps1 -Domain attendance.earth.ac.cr -AdminEmail ops@earth.ac.cr

.EXAMPLE
  .\Deploy-VictorHugo.ps1 -Domain attendance.earth.ac.cr -AdminEmail ops@earth.ac.cr -Shape A1

.NOTES
  Prereqs (one-time):
    1. Install OCI CLI:
         https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm
    2. Configure it:
         oci setup config
       You'll need from the Oracle Cloud Console:
         - User OCID:     Profile menu > User Settings > OCID
         - Tenancy OCID:  Profile menu > Tenancy > OCID
         - Region:        same as your console region (e.g. us-ashburn-1)
       Upload the generated public key (~/.oci/oci_api_key_public.pem)
       under Profile > User Settings > API Keys.
    3. Install OpenSSH client (Settings > Apps > Optional Features) if you
       can't already `ssh` from PowerShell.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Domain,
    [Parameter(Mandatory=$true)][string]$AdminEmail,
    [ValidateSet('MICRO','A1')][string]$Shape = 'MICRO',
    [string]$InstanceName = 'victor-hugo',
    [string]$RepoUrl = 'https://github.com/alfaponics6-dot/victor-hugo-attendance.git',
    [string]$LeaderAccessCode,
    [switch]$SkipProvision,
    [string]$ExistingPublicIp
)

$ErrorActionPreference = 'Stop'

function Write-Section($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Detail($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Ok($msg)      { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Die($msg)           { Write-Host "FATAL: $msg" -ForegroundColor Red; exit 1 }

# -----------------------------------------------------------------
# 1. Prerequisite checks
# -----------------------------------------------------------------
Write-Section 'Checking prerequisites'
foreach ($cmd in @('oci','ssh','ssh-keygen')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Die "$cmd not found in PATH. See the script header (Get-Help .\Deploy-VictorHugo.ps1)."
    }
    Write-Ok "$cmd present"
}

# Verify OCI auth works. `oci iam region list` is a cheap, read-only call.
try {
    $null = & oci iam region list --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'oci returned non-zero' }
    Write-Ok 'OCI CLI authenticated'
} catch {
    Die @"
OCI CLI is installed but not configured. Run:

    oci setup config

then add the generated public key to your Oracle Cloud user under
Profile > User Settings > API Keys. See the script header for full
prereq notes.
"@
}

# Read tenancy OCID from the config - we'll use it as compartment by default.
$ociConfigPath = Join-Path $HOME '.oci\config'
if (-not (Test-Path $ociConfigPath)) { Die "Missing $ociConfigPath" }
$cfgLine = Select-String -Path $ociConfigPath -Pattern '^tenancy=' | Select-Object -First 1
if (-not $cfgLine) { Die 'No tenancy= line found in ~/.oci/config' }
$TenancyOcid = ($cfgLine.Line -split '=', 2)[1].Trim()
$CompartmentOcid = if ($env:COMPARTMENT_OCID) { $env:COMPARTMENT_OCID } else { $TenancyOcid }
Write-Detail "Compartment: $CompartmentOcid"

# -----------------------------------------------------------------
# 2. SSH key (generate if missing)
# -----------------------------------------------------------------
Write-Section 'SSH key'
$SshKeyPath = Join-Path $HOME '.ssh\id_ed25519'
if (-not (Test-Path $SshKeyPath)) {
    Write-Detail "No key at $SshKeyPath - generating ed25519 keypair"
    $sshDir = Join-Path $HOME '.ssh'
    if (-not (Test-Path $sshDir)) { New-Item -ItemType Directory -Force $sshDir | Out-Null }
    & ssh-keygen -t ed25519 -f $SshKeyPath -N '""' -C 'victor-hugo-deploy' | Out-Null
}
$SshPubKey = (Get-Content "$SshKeyPath.pub" -Raw).Trim()
Write-Ok "Public key: $SshKeyPath.pub"

# -----------------------------------------------------------------
# 3. Shape + availability domain + image
# -----------------------------------------------------------------
Write-Section 'Resolving shape, availability domain, image'

$ShapeConfig = @{
    MICRO = @{ Name = 'VM.Standard.E2.1.Micro'; Ocpus = 1; MemGb = 1;  Arch = 'x86_64' }
    A1    = @{ Name = 'VM.Standard.A1.Flex';    Ocpus = 2; MemGb = 12; Arch = 'aarch64' }
}
$S = $ShapeConfig[$Shape]
Write-Detail "Shape: $($S.Name) ($($S.Ocpus) OCPU, $($S.MemGb) GB)"

$ad = (& oci iam availability-domain list --compartment-id $CompartmentOcid --output json | ConvertFrom-Json).data[0].name
Write-Detail "Availability domain: $ad"

# Find latest Ubuntu 22.04 image matching this shape's architecture.
$imageJson = & oci compute image list `
    --compartment-id $CompartmentOcid `
    --operating-system 'Canonical Ubuntu' `
    --operating-system-version '22.04' `
    --shape $S.Name `
    --sort-by TIMECREATED --sort-order DESC `
    --all --output json | ConvertFrom-Json
if (-not $imageJson.data -or $imageJson.data.Count -eq 0) {
    Die "No Ubuntu 22.04 image found for shape $($S.Name). Try a different region or shape."
}
$ImageOcid = $imageJson.data[0].id
Write-Detail "Image OCID: $ImageOcid"

# -----------------------------------------------------------------
# 4. Network resources (idempotent - match by display name)
# -----------------------------------------------------------------
function Get-ByName($listJson, $name) {
    if (-not $listJson.data) { return $null }
    return ($listJson.data | Where-Object { $_.'display-name' -eq $name } | Select-Object -First 1)
}

$publicIp = $null

if (-not $SkipProvision) {
    Write-Section 'Provisioning network'

    # VCN
    $vcnList = & oci network vcn list --compartment-id $CompartmentOcid --output json | ConvertFrom-Json
    $vcn = Get-ByName $vcnList 'victor-hugo-vcn'
    if (-not $vcn) {
        Write-Detail 'Creating VCN victor-hugo-vcn (10.0.0.0/16)'
        $vcn = (& oci network vcn create `
            --compartment-id $CompartmentOcid `
            --cidr-block '10.0.0.0/16' `
            --display-name 'victor-hugo-vcn' `
            --dns-label 'victorhugo' `
            --wait-for-state AVAILABLE `
            --output json | ConvertFrom-Json).data
    }
    Write-Ok "VCN: $($vcn.id)"

    # Internet Gateway
    $igwList = & oci network internet-gateway list --compartment-id $CompartmentOcid --vcn-id $vcn.id --output json | ConvertFrom-Json
    $igw = Get-ByName $igwList 'victor-hugo-igw'
    if (-not $igw) {
        Write-Detail 'Creating Internet Gateway'
        $igw = (& oci network internet-gateway create `
            --compartment-id $CompartmentOcid `
            --vcn-id $vcn.id `
            --is-enabled $true `
            --display-name 'victor-hugo-igw' `
            --wait-for-state AVAILABLE `
            --output json | ConvertFrom-Json).data
    }
    Write-Ok "IGW: $($igw.id)"

    # Route Table
    $rtList = & oci network route-table list --compartment-id $CompartmentOcid --vcn-id $vcn.id --output json | ConvertFrom-Json
    $rt = Get-ByName $rtList 'victor-hugo-rt'
    if (-not $rt) {
        Write-Detail 'Creating Route Table to IGW'
        $routeRules = (@(
            @{
                destination = '0.0.0.0/0'
                destinationType = 'CIDR_BLOCK'
                networkEntityId = $igw.id
            }
        ) | ConvertTo-Json -Compress -Depth 4)
        $rt = (& oci network route-table create `
            --compartment-id $CompartmentOcid `
            --vcn-id $vcn.id `
            --display-name 'victor-hugo-rt' `
            --route-rules $routeRules `
            --wait-for-state AVAILABLE `
            --output json | ConvertFrom-Json).data
    }
    Write-Ok "RT: $($rt.id)"

    # Security List - ingress 22, 80, 443
    $slList = & oci network security-list list --compartment-id $CompartmentOcid --vcn-id $vcn.id --output json | ConvertFrom-Json
    $sl = Get-ByName $slList 'victor-hugo-sl'
    if (-not $sl) {
        Write-Detail 'Creating Security List (open 22/80/443)'
        $ingress = (@(
            @{ source='0.0.0.0/0'; sourceType='CIDR_BLOCK'; protocol='6'; isStateless=$false; tcpOptions=@{ destinationPortRange=@{ min=22; max=22 } } },
            @{ source='0.0.0.0/0'; sourceType='CIDR_BLOCK'; protocol='6'; isStateless=$false; tcpOptions=@{ destinationPortRange=@{ min=80; max=80 } } },
            @{ source='0.0.0.0/0'; sourceType='CIDR_BLOCK'; protocol='6'; isStateless=$false; tcpOptions=@{ destinationPortRange=@{ min=443; max=443 } } }
        ) | ConvertTo-Json -Compress -Depth 6)
        $egress = (@(
            @{ destination='0.0.0.0/0'; destinationType='CIDR_BLOCK'; protocol='all'; isStateless=$false }
        ) | ConvertTo-Json -Compress -Depth 4)
        $sl = (& oci network security-list create `
            --compartment-id $CompartmentOcid `
            --vcn-id $vcn.id `
            --display-name 'victor-hugo-sl' `
            --ingress-security-rules $ingress `
            --egress-security-rules $egress `
            --wait-for-state AVAILABLE `
            --output json | ConvertFrom-Json).data
    }
    Write-Ok "SL: $($sl.id)"

    # Subnet
    $subnetList = & oci network subnet list --compartment-id $CompartmentOcid --vcn-id $vcn.id --output json | ConvertFrom-Json
    $subnet = Get-ByName $subnetList 'victor-hugo-subnet'
    if (-not $subnet) {
        Write-Detail 'Creating subnet 10.0.0.0/24'
        $subnet = (& oci network subnet create `
            --compartment-id $CompartmentOcid `
            --vcn-id $vcn.id `
            --cidr-block '10.0.0.0/24' `
            --display-name 'victor-hugo-subnet' `
            --route-table-id $rt.id `
            --security-list-ids "[`"$($sl.id)`"]" `
            --dns-label 'vh' `
            --wait-for-state AVAILABLE `
            --output json | ConvertFrom-Json).data
    }
    Write-Ok "Subnet: $($subnet.id)"

    # -----------------------------------------------------------------
    # 5. Launch VM
    # -----------------------------------------------------------------
    Write-Section "Launching VM $InstanceName"

    # Metadata: SSH key. The JSON is sensitive to quoting so we serialise once
    # and pass the whole blob.
    $metadata = (@{ ssh_authorized_keys = $SshPubKey } | ConvertTo-Json -Compress)
    $tags = (@{ app = 'victor-hugo'; domain = $Domain } | ConvertTo-Json -Compress)

    $launchArgs = @(
        'compute','instance','launch',
        '--compartment-id', $CompartmentOcid,
        '--availability-domain', $ad,
        '--shape', $S.Name,
        '--image-id', $ImageOcid,
        '--subnet-id', $subnet.id,
        '--display-name', $InstanceName,
        '--assign-public-ip', 'true',
        '--hostname-label', 'vh',
        '--metadata', $metadata,
        '--freeform-tags', $tags,
        '--wait-for-state', 'RUNNING',
        '--output', 'json'
    )
    if ($S.Name -eq 'VM.Standard.A1.Flex') {
        $shapeCfg = (@{ ocpus = $S.Ocpus; memoryInGBs = $S.MemGb } | ConvertTo-Json -Compress)
        $launchArgs += @('--shape-config', $shapeCfg)
    }

    Write-Detail '(this takes ~2 minutes)'
    $instance = (& oci @launchArgs | ConvertFrom-Json).data
    Write-Ok "Instance: $($instance.id)"

    # Get the public IP. After RUNNING there is one VNIC attached.
    $vnic = (& oci compute instance list-vnics --instance-id $instance.id --output json | ConvertFrom-Json).data
    $publicIp = $vnic[0].'public-ip'
    Write-Ok "Public IP: $publicIp"
} else {
    if (-not $ExistingPublicIp) { Die '-SkipProvision requires -ExistingPublicIp' }
    $publicIp = $ExistingPublicIp
    Write-Section 'Skipping provisioning'
    Write-Ok "Using existing VM at $publicIp"
}

# -----------------------------------------------------------------
# 6. Wait for SSH to come up
# -----------------------------------------------------------------
Write-Section "Waiting for SSH on $publicIp"
$deadline = (Get-Date).AddMinutes(5)
$sshReady = $false
while ((Get-Date) -lt $deadline) {
    $probe = Test-NetConnection -ComputerName $publicIp -Port 22 -WarningAction SilentlyContinue
    if ($probe.TcpTestSucceeded) { $sshReady = $true; break }
    Start-Sleep -Seconds 5
    Write-Detail '... still booting'
}
if (-not $sshReady) { Die "SSH on $publicIp never opened. Check the instance state in the Oracle Console." }
Write-Ok 'SSH up'

# Give cloud-init a few more seconds to add our key to authorized_keys.
Start-Sleep -Seconds 8

# -----------------------------------------------------------------
# 7. DNS pre-flight (advisory - not fatal)
# -----------------------------------------------------------------
Write-Section "Verifying DNS for $Domain"
try {
    $resolved = (Resolve-DnsName -Name $Domain -Type A -ErrorAction Stop).IPAddress
    if ($resolved -contains $publicIp) {
        Write-Ok "$Domain resolves to $publicIp"
    } else {
        Write-Warn "$Domain currently resolves to $resolved, not $publicIp"
        Write-Warn 'Update your DNS A record to point at the new IP before letting certbot run, or'
        Write-Warn 'cert issuance will fail and you will need to re-run bootstrap.sh after fixing DNS.'
        Read-Host 'Press Enter when DNS is pointed at the VM (or Ctrl+C to abort)' | Out-Null
    }
} catch {
    Write-Warn "Could not resolve $Domain at all yet."
    Write-Warn "Add an A record: $Domain -> $publicIp, wait ~5 min, verify with: nslookup $Domain"
    Read-Host 'Press Enter when DNS is set (or Ctrl+C to abort)' | Out-Null
}

# -----------------------------------------------------------------
# 8. Generate fresh secrets
# -----------------------------------------------------------------
function New-Base64Secret([int]$Bytes = 48) {
    $b = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return [Convert]::ToBase64String($b)
}
$JwtSecret = New-Base64Secret 48
if (-not $LeaderAccessCode) {
    $raw = (New-Base64Secret 9)
    $clean = $raw.Replace('+','').Replace('/','').Replace('=','')
    if ($clean.Length -gt 12) { $LeaderAccessCode = $clean.Substring(0,12) } else { $LeaderAccessCode = $clean }
}
Write-Ok "Generated JWT_SECRET (96 chars)"
Write-Ok "LEADER_ACCESS_CODE: $LeaderAccessCode  (share with your leaders)"

# -----------------------------------------------------------------
# 9. Remote bootstrap over SSH
# -----------------------------------------------------------------
Write-Section "Bootstrapping app on $publicIp"

$sshTarget = "ubuntu@$publicIp"
$sshOpts = @('-i', $SshKeyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + (Join-Path $HOME '.ssh\known_hosts'))

# Single-quoted PowerShell here-string so neither PowerShell nor the local
# shell mangle the bash `$VAR` references. We splice values in via
# placeholder replacement just below.
$remoteTemplate = @'
set -euo pipefail

export DOMAIN='__DOMAIN__'
export ADMIN_EMAIL='__ADMIN_EMAIL__'
export JWT_SECRET='__JWT_SECRET__'
export LEADER_ACCESS_CODE='__LEADER_ACCESS_CODE__'
REPO_URL='__REPO_URL__'

echo '==> Updating apt + installing git'
sudo apt-get update -qq
sudo apt-get install -y -qq git ca-certificates

echo "==> Cloning ${REPO_URL}"
sudo mkdir -p /opt
sudo chown ubuntu:ubuntu /opt
if [ -d /opt/victorhugo/.git ]; then
  cd /opt/victorhugo && git pull --ff-only
else
  git clone "${REPO_URL}" /opt/victorhugo
fi
cd /opt/victorhugo

echo '==> Writing /opt/victorhugo/server/.env'
cat > server/.env <<ENVEOF
PORT=3000
NODE_ENV=production
CORS_ORIGINS=https://${DOMAIN}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
LEADER_ACCESS_CODE=${LEADER_ACCESS_CODE}
TRUST_PROXY=true
ENVEOF
chmod 600 server/.env

echo '==> Adding 2 GB swap (required on MICRO; idempotent)'
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi
free -h | head -2

echo '==> Running deploy/bootstrap.sh (Node, build, nginx, certbot, systemd, cron)'
chmod +x deploy/bootstrap.sh
sudo -E ./deploy/bootstrap.sh

echo
echo '==> Smoke checks'
curl -fsS "https://${DOMAIN}/api/health" || echo '   (health not reachable yet; certbot may still be settling)'
echo
curl -fsS "https://${DOMAIN}/api/health/ready" || echo '   (ready not reachable yet)'
echo
echo "Deploy finished. SPA: https://${DOMAIN}"
'@

$remoteScript = $remoteTemplate.Replace('__DOMAIN__', $Domain).Replace('__ADMIN_EMAIL__', $AdminEmail).Replace('__JWT_SECRET__', $JwtSecret).Replace('__LEADER_ACCESS_CODE__', $LeaderAccessCode).Replace('__REPO_URL__', $RepoUrl)

# Push the script over stdin so we don't have to mess with quoting + scp.
$remoteScript | & ssh @sshOpts $sshTarget 'bash -s'
if ($LASTEXITCODE -ne 0) { Die 'Remote bootstrap returned non-zero' }

# -----------------------------------------------------------------
# 10. Final summary
# -----------------------------------------------------------------
Write-Host @"

============================================================
 DEPLOY COMPLETE
============================================================
 URL                : https://$Domain
 Public IP          : $publicIp
 Shape              : $($S.Name)
 SSH                : ssh -i `"$SshKeyPath`" ubuntu@$publicIp
 LEADER_ACCESS_CODE : $LeaderAccessCode   (share with leaders)
 JWT_SECRET         : (set on the VM; stored only in server/.env, chmod 600)
============================================================

Next:
 - Open https://$Domain and verify the login screen loads.
 - Log in as leader id=3 (Carly Chery) with the access code above to
   sanity-check the auth flow.

If anything went wrong, SSH in and tail the service log:
   sudo journalctl -u victorhugo-api -n 200 --no-pager
"@ -ForegroundColor Green
