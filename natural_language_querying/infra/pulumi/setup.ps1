# Provisioning prerequisites for the Neptune-min Pulumi stack.
#
# What this does:
#   1. Generates an SSH keypair locally with ssh-keygen (RSA 4096).
#   2. Imports the public half into AWS as a Key Pair named `neptune-min-key`.
#      (No need to create one in the console first.)
#   3. Detects your laptop's public IP via ipify.
#   4. Writes both values to Pulumi stack config.
#
# Prereqs you must already have installed and on PATH:
#   - aws CLI v2, configured with credentials that can create EC2 key pairs
#     (run `aws configure` once before this script)
#   - pulumi CLI
#   - ssh-keygen (built into Windows 11 / git-for-windows / OpenSSH)
#
# Result on disk:
#   - ./.ssh/neptune-min-key      (private key, mode 600 on POSIX, normal on Win)
#   - ./.ssh/neptune-min-key.pub  (public key — uploaded to AWS)
#   - AWS Key Pair "neptune-min-key" in your current AWS region
#   - Pulumi config values `keyName` and `myIp` for the current stack
#
# Re-runnable. If the key pair already exists in AWS, the script stops with a
# clear message — delete it first (`aws ec2 delete-key-pair --key-name neptune-min-key`)
# or pick a different name via $KeyName below.

# -----------------------------------------------------------------------------
# Parameters
# -----------------------------------------------------------------------------
$KeyName   = "neptune-min-key"
$StackName = "dev"
$SshDir    = "./.ssh"
$PrivPath  = "$SshDir/$KeyName"
$PubPath   = "$SshDir/$KeyName.pub"

# -----------------------------------------------------------------------------
# 0. Sanity checks
# -----------------------------------------------------------------------------
foreach ($tool in "aws","pulumi","ssh-keygen") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "Missing required tool on PATH: $tool"; exit 1
    }
}

# -----------------------------------------------------------------------------
# 1. Generate SSH keypair locally (idempotent — skips if both files already exist)
# -----------------------------------------------------------------------------
if (-not (Test-Path $PrivPath) -or -not (Test-Path $PubPath)) {
    Write-Host "Generating SSH keypair at $PrivPath ..."
    New-Item -ItemType Directory -Path $SshDir -Force | Out-Null
    ssh-keygen -t rsa -b 4096 -N '""' -f $PrivPath -C "neptune-min-bastion" -q
    Write-Host "  done."
} else {
    Write-Host "Reusing existing keypair at $PrivPath"
}

# -----------------------------------------------------------------------------
# 2. Import the public key into AWS as a Key Pair (idempotent-enough)
# -----------------------------------------------------------------------------
$awsRegion = $env:AWS_DEFAULT_REGION
if (-not $awsRegion) {
    $awsRegion = (aws configure get region)
}
if (-not $awsRegion) { Write-Error "Set AWS_DEFAULT_REGION or run `aws configure`."; exit 1 }
Write-Host "AWS region: $awsRegion"

$existing = aws ec2 describe-key-pairs --region $awsRegion --key-names $KeyName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Key Pair '$KeyName' already exists in region $awsRegion — reusing it."
} else {
    Write-Host "Importing public key into AWS as Key Pair '$KeyName' ..."
    aws ec2 import-key-pair --region $awsRegion `
        --key-name $KeyName `
        --public-key-material "fileb://$PubPath" `
        --query KeyPairId --output text | Out-Null
    Write-Host "  done."
}

# -----------------------------------------------------------------------------
# 3. Detect this machine's public IP (as AWS sees it through NAT)
# -----------------------------------------------------------------------------
Write-Host "Detecting public IP ..."
$publicIp = (Invoke-WebRequest -UseBasicParsing -Uri "https://api.ipify.org").Content.Trim()
if (-not $publicIp) { Write-Error "Could not detect public IP."; exit 1 }
Write-Host "  detected: $publicIp"
$myIpCidr = "$publicIp/32"

# -----------------------------------------------------------------------------
# 4. Pulumi config
# -----------------------------------------------------------------------------
Write-Host "Setting Pulumi stack config (stack: $StackName) ..."
pulumi stack select $StackName 2>$null
if ($LASTEXITCODE -ne 0) {
    pulumi stack init $StackName
}
pulumi config set keyName $KeyName
pulumi config set myIp   $myIpCidr
Write-Host "  done."

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "=============================================================="
Write-Host "Setup complete. Now run:"
Write-Host "   pulumi preview"
Write-Host "   pulumi up"
Write-Host ""
Write-Host "When pulumi up finishes, SSH into the bastion with:"
Write-Host "   ssh -i $PrivPath ec2-user@<bastion-public-ip>"
Write-Host ""
Write-Host "The bastion public IP is in Pulumi outputs: pulumi stack output bastionPublicIp"
Write-Host "=============================================================="