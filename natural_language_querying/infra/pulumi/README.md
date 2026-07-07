# Neptune-min infra (Pulumi, TypeScript)

Provisions a minimum Amazon Neptune cluster reachable from your laptop via an
SSH tunnel through a bastion EC2. Designed to run the `Natural_Language_Querying_LangChain_openCypher.ipynb` notebook locally using `graph-notebook`.

See **`../../NETWORKING.md`** for the topology diagram and why each piece is
required.

## Prerequisites (install once, machine-wide)

| Tool | Why | Install (Windows) |
|---|---|---|
| **Pulumi CLI** v3+ | Runs the program, manages state | `winget install pulumi.pulumi` or `choco install pulumi` |
| **AWS CLI v2** | Creates the EC2 key pair, used by Pulumi's AWS provider | `winget install Amazon.AWSCLI` |
| **Node.js 20+** | Runtime for the Pulumi program | `winget install OpenJS.NodeJS.LTS` |
| **OpenSSH** (`ssh-keygen`, `ssh`) | Generate the keypair, open the tunnel | Built into Windows 11; or install git-for-windows |

Verify:
```powershell
pulumi version
aws --version
node --version
ssh-keygen -V
```

## First-time setup (run once)

All commands run from this directory
(`natural_language_querying/infra/pulumi/`).

### 1. Configure AWS credentials

```powershell
aws configure
# Access key, secret key, region (use us-east-1 or any region you have access to),
# output (text or json). The IAM user needs ec2:* and neptune:* permissions.
```

### 2. Use local state (no Pulumi Cloud account required)

```powershell
pulumi login --local
```

State files live in `~/.pulumi/`. No network, no signup, no token.

### 3. Set the encryption passphrase for stack secrets

Pulumi's local mode encrypts secrets in state with a passphrase. Set it for the
current shell:

```powershell
# PowerShell — current session only
$env:PULUMI_CONFIG_PASSPHRASE = "neptune-min-dev-passphrase"

# Or persist for future sessions (recommended)
[Environment]::SetEnvironmentVariable(
  "PULUMI_CONFIG_PASSPHRASE", "neptune-min-dev-passphrase", "User")
```

> Pick your own passphrase. If you forget it, stack secrets become unreadable.
> Use `PULUMI_CONFIG_PASSPHRASE_FILE` to point at a file containing the
> passphrase if you prefer file-based secrets.

### 4. Create the stack

```powershell
pulumi stack init dev
```

### 5. Set the AWS region Pulumi will deploy into

```powershell
pulumi config set aws:region us-east-1
# replace with your region if different
```

### 6. Create an EC2 Key Pair (for SSH to the bastion)

**Way A — generate locally, import the public key (recommended):**

```powershell
# 1. Generate the keypair locally (RSA 4096, no passphrase for automation use)
ssh-keygen -t rsa -b 4096 -N '""' -f "$HOME/.ssh/neptune-min-key" -C "neptune-min"

# 2. Import the public key into AWS as a named Key Pair
aws ec2 import-key-pair `
  --region us-east-1 `
  --key-name neptune-min-key `
  --public-key-material "fileb://$HOME/.ssh/neptune-min-key.pub" `
  --query KeyPairId --output text
```

**Way B — let AWS generate it (you download the .pem once):**

```powershell
aws ec2 create-key-pair `
  --region us-east-1 `
  --key-name neptune-min-key `
  --query 'KeyMaterial' `
  --output text > "$HOME/.ssh/neptune-min-key.pem"
```

> Whatever you pick, remember the **private key path** on your laptop —
> you'll use it to SSH into the bastion. The **name** `neptune-min-key` is
> what you'll tell Pulumi.

### 7. Paste the key name into Pulumi config

```powershell
pulumi config set keyName neptune-min-key
```

### 8. Detect your laptop's public IPv4 and set it in config

```powershell
# Get your laptop's public IPv4 (the address AWS sees when you SSH out)
$myIp = (Invoke-WebRequest -UseBasicParsing -Uri "https://api.ipify.org").Content.Trim()

# Set it in Pulumi config as /32 (one IP only — locks bastion SSH to your laptop)
pulumi config set myIp "$myIp/32"
```

> Why `/32`? It limits the bastion's SSH ingress to exactly your laptop. Do
> not use `0.0.0.0/0` — that's "anyone on earth can SSH your bastion".

### 9. Run the dry run (no resources created)

```powershell
pulumi preview
```

You should see 7 resources to create:
- 2 security groups (bastion, neptune)
- 1 bastion EC2 instance (`t3.micro`, Amazon Linux 2023, public IP)
- 1 Neptune DB Subnet Group (spans the default VPC's AZs)
- 1 Neptune Cluster (writer)
- 1 Neptune Cluster Instance (`db.r5.large`)
- 1 Pulumi stack

## Day-to-day operations

### Deploy (creates all resources in AWS)

```powershell
pulumi up
```

Confirms with a diff, then prompts yes/no. Takes ~10–15 min on first deploy
(Neptune cluster creation is the long pole).

### Get the outputs

```powershell
pulumi stack output neptuneEndpoint
pulumi stack output bastionPublicIp
pulumi stack output sshTunnelCommand
```

`sshTunnelCommand` is a ready-to-paste one-liner that opens the tunnel.

### Open the SSH tunnel

In a **separate terminal** (this terminal stays open while you use Neptune):

```powershell
ssh -i "$HOME/.ssh/neptune-min-key" `
    -N -L 8182:$($ulumi stack output neptuneEndpoint):8182 `
    ec2-user@$($pulumi stack output bastionPublicIp)
```

Now `localhost:8182` on your laptop is transparently forwarded to Neptune's
private IP on port 8182, through the bastion's private IP.

### Run the notebook

1. Open `../../Natural_Language_Querying_LangChain_openCypher.ipynb` in VSCode
2. Select the **"Python 3.14 (Neptune NLQ)"** kernel (registered earlier — see top-level README)
3. Add a header cell at the top with the following, run it:

```python
%load_ext graph_notebook.magics
```

4. Below it, add a config cell:

```python
%%graph_notebook_config
{
  "host": "localhost",
  "neptune_service": "neptune-db",
  "port": 8182,
  "auth_mode": "DEFAULT",
  "ssl": true,
  "ssl_verify": false,
  "aws_region": "us-east-1"
}
```

`ssl_verify: false` because the cert on `localhost` won't match Neptune's
hostname — the tunnel breaks hostname matching. Fine for a local session;
tighten in production.

5. Run cells top-to-bottom. `%seed` loads the air-routes dataset. The rest of
   the notebook runs against a live Neptune instance.

## Tear down (run when done to stop the bill)

```powershell
pulumi destroy
```

Confirms, then deletes every resource in reverse dependency order. Neptune
cluster deletion takes ~5–20 min (skipping final snapshot, as configured).

To also remove the stack itself:

```powershell
pulumi stack rm dev --yes
```

The AWS Key Pair created in step 6 is **not** managed by Pulumi and won't be
destroyed. Remove it with:

```powershell
aws ec2 delete-key-pair --region us-east-1 --key-name neptune-min-key
```

## Cost

`db.r5.large` (smallest non-serverless Neptune instance) is roughly
**$0.385/hr** (~$280/mo if left running 24/7). The bastion is `t3.micro`,
effectively free (~$8/mo). **Tear the stack down between sessions** with
`pulumi destroy` to avoid surprises.

For cheaper idle behavior, modify the program to use **Neptune Serverless**
(set `engineVersion` to a Serverless-capable version and add a
`serverlessScalingConfiguration` block to the cluster — no separate
`ClusterInstance` needed). The cluster scales to near-zero when not queried.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required configuration variable 'neptune-min:keyName'` | Config not set on this stack | `pulumi config set keyName <name>` |
| `passphrase must be set with PULUMI_CONFIG_PASSPHRASE` | Local-mode secrets passphrase env var unset | `$env:PULUMI_CONFIG_PASSPHRASE = "<your-passphrase>"` |
| `incorrect passphrase` | Stack was created with a different passphrase | Delete + recreate the stack: `pulumi stack rm dev --yes; pulumi stack init dev` |
| `Missing region information` | AWS region not set in Pulumi config | `pulumi config set aws:region us-east-1` |
| Preview works, `pulumi up` fails on `aws.neptune.Cluster` | Cluster endpoint / subnet group IDs not propagated, IAM perms | Check IAM permissions include `neptune:CreateDBCluster`, `ec2:*` |
| `ssh: connect to host ... port 22: Connection refused` | Bastion security group not allowing your IP, or your IP changed (DHCP) | Re-run the IP detection step (set 8) and `pulumi up` to refresh the SG |
| `ssh: Permission denied (publickey)` | Wrong private key file, or key file permissions too open | On Windows: `icacls <key> /inheritance:r /grant:r "$($env:USERNAME):(R)"` |

## File map

```
.
├── Pulumi.yaml               — project metadata
├── Pulumi.dev.yaml.example    — sample stack config (copy to Pulumi.dev.yaml)
├── package.json
├── tsconfig.json
├── index.ts                   — the Pulumi program (compiles cleanly)
├── setup.ps1                  — automated version of steps 6, 7, 8
├── node_modules/              — @pulumi/aws, @pulumi/pulumi
└── README.md                  — this file
```

If you'd rather skip steps 6–8, run `setup.ps1` (it generates the keypair,
imports to AWS, detects IPv4, sets all Pulumi config in one go).