# Neptune-min infra (Pulumi, TypeScript)

Provisions a minimum Amazon Neptune graph reachable from your laptop, designed
to run the `Natural_Language_Querying_LangChain_openCypher.ipynb` notebook
locally using `graph-notebook`.

Two engines are supported via the `engine` config value:

| `engine` | What you get | Bastion? | Auth | Suits Bedrock KB? |
|---|---|---|---|---|
| `analytics` (**default**) | Neptune Analytics graph (`aws.neptunegraph.Graph`) with a public DNS endpoint | **No** — laptop hits the public hostname directly | IAM enforced | ✅ Yes — only Neptune engine Bedrock KB accepts |
| `db` | Neptune Database cluster (`aws.neptune.Cluster` + `ClusterInstance`) on a private VPC, reached via an SSH tunnel through a `t3.micro` bastion EC2 | **Yes** — `keyName` + your laptop IPv4 required | DEFAULT (or IAM, configurable) | ❌ Not accepted by Bedrock KB API |

Switch with: `pulumi config set engine analytics` (or `db`).

Both engine paths run the same NLQ notebook unchanged — see
[`../../NETWORKING.md`](../../NETWORKING.md) for the full topology diagrams,
per-piece rationale, and capability comparison.

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
# output (text or json). The IAM user needs perms on the engine you choose:
#   - engine=analytics → neptune-graph:* (no EC2 perms needed)
#   - engine=db         → ec2:* + neptune:* (bastion + Neptune cluster)
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

### 5b. Choose the engine — `analytics` (default) or `db`

```powershell
# Default — Neptune Analytics. Skips the bastion/key/SG steps below.
pulumi config set engine analytics

# Alternative — Neptune Database. Requires step 6 (key pair) and step 8 (your IP).
pulumi config set engine db
```

If `engine=analytics`, **skip steps 6, 7, 8** — `keyName` and `myIp` are
ignored. You don't need a key pair, a bastion, or security groups.

If `engine=db`, continue with steps 6–8 — the bastion SSH tunnel needs them.

### 6. Create an EC2 Key Pair (for SSH to the bastion) — only required if `engine=db`

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

You should see resources to create:
- **If `engine=analytics`** (default): 2 resources
  - 1 Neptune Analytics graph (`aws:neptunegraph:Graph`, 16 m-NCU default)
  - 1 Pulumi stack
- **If `engine=db`**: 7 resources
  - 2 security groups (bastion, neptune)
  - 1 bastion EC2 instance (`t3.micro`, Amazon Linux 2023, public IP)
  - 1 Neptune DB Subnet Group (spans the default VPC's AZs)
  - 1 Neptune Cluster (writer)
  - 1 Neptune Cluster Instance (`db.r5.large`)
  - 1 Pulumi stack

> Warnings about `Undefined value (bastionIp)` (when `engine=analytics`) or
> `Undefined value (graphId)` (when `engine=db`) are expected — those outputs
> only exist for their respective engine path. Ignore them.

## Day-to-day operations

### Deploy (creates all resources in AWS)

```powershell
pulumi up
```

Confirms with a diff, then prompts yes/no.
- **analytics**: ~5–10 min (graph creation)
- **db**: ~10–15 min (Neptune cluster creation is the long pole)

### Get the outputs

```powershell
pulumi stack output engine                 # "analytics" | "db"
pulumi stack output endpoint               # graph DNS hostname (analytics) or cluster endpoint (db)
pulumi stack output noteForGraphNotebook   # ready-to-paste %graph_notebook_config block for the notebook
# Analytics-only outputs:
pulumi stack output graphId                # e.g. g-xxxxxxxxxxxx
pulumi stack output graphArn               # ARN, for wiring into Bedrock KB
# DB-only outputs:
pulumi stack output bastionIp              # bastion EC2 public IP
pulumi stack output sshTunnelCommand       # ready-to-paste SSH tunnel one-liner
```

### Open the SSH tunnel (only applies to `engine=db`)

In a **separate terminal** (this terminal stays open while you use Neptune):

```powershell
ssh -i "$HOME/.ssh/neptune-min-key" `
    -N -L 8182:$($pulumi stack output endpoint):8182 `
    ec2-user@$($pulumi stack output bastionIp)
```

Now `localhost:8182` on your laptop is transparently forwarded to Neptune's

In a **separate terminal** (this terminal stays open while you use Neptune):

```powershell
ssh -i "$HOME/.ssh/neptune-min-key" `
    -N -L 8182:$($pulumi stack output endpoint):8182 `
    ec2-user@$($pulumi stack output bastionIp)
```

Now `localhost:8182` on your laptop is transparently forwarded to Neptune's
private IP on port 8182, through the bastion's private IP. (Applies only
when `engine=db`.)

### Run the notebook

The notebook works against either engine. The only difference is the
`%graph_notebook_config` cell.

1. Open `../../Natural_Language_Querying_LangChain_openCypher.ipynb` in VSCode
2. Select the **"Python 3.14 (Neptune NLQ)"** kernel (registered earlier — see top-level README)
3. Add a header cell at the top, run it:

```python
%load_ext graph_notebook.magics
```

4. Below it, paste the `%%graph_notebook_config` block — the easiest way is to
   run `pulumi stack output noteForGraphNotebook` and paste the printed block
   into a cell. The two variants:

**If `engine=analytics`:**
```python
%%graph_notebook_config
{
  "host": "<graph-endpoint-from-stack-output>",
  "neptune_service": "neptune-graph",
  "port": 8182,
  "auth_mode": "IAM",
  "load_from_s3_arn": "",
  "ssl": true,
  "aws_region": "us-east-1"
}
```
No tunnel. IAM auth is mandatory — graph_notebook SigV4-signs every request
using your AWS creds (`aws configure`). No `ssl_verify:false` needed because
the cert matches the public hostname.

**If `engine=db`:**
```python
%%graph_notebook_config
{
  "host": "localhost",
  "neptune_service": "neptune-db",
  "port": 8182,
  "auth_mode": "DEFAULT",
  "load_from_s3_arn": "",
  "ssl": true,
  "ssl_verify": false,
  "aws_region": "us-east-1"
}
```
Open the SSH tunnel first (see above). `ssl_verify: false` because the cert
on `localhost` won't match Neptune's hostname — the tunnel breaks hostname
matching. Fine for a local session; tighten in production.

5. Run cells top-to-bottom. `%seed` loads the air-routes dataset. The rest of
   the notebook runs against a live Neptune instance.

## Tear down (run when done to stop the bill)

```powershell
pulumi destroy
```

Confirms, then deletes every resource in reverse dependency order.
- **analytics**: graph deletion ~5–10 min
- **db**: cluster deletion ~5–20 min (skipping final snapshot, as configured)

To also remove the stack itself:

```powershell
pulumi stack rm dev --yes
```

The AWS Key Pair created in step 6 (only used when `engine=db`) is **not**
managed by Pulumi and won't be destroyed. Remove it with:

```powershell
aws ec2 delete-key-pair --region us-east-1 --key-name neptune-min-key
```

## Cost

| Engine | Resource | Idle cost | Notes |
|---|---|---|---|
| `analytics` (default) | `aws.neptunegraph.Graph`, 16 m-NCU | ~$0.16–$0.20/hr — **always on while graph exists** | No serverless scaling. **Tear down between sessions.** Best fit for Bedrock KB GraphRAG. |
| `db` | `db.r5.large` (default) + `t3.micro` bastion | ~$0.385/hr + ~$0.005/hr ≈ $280/mo if left running 24/7 | **Tear down between sessions.** |
| `db` (alternative) | `db.serverless` instance — change `instanceClass` and add `serverlessV2ScalingConfiguration` to the cluster in `index.ts` | Near-zero when not queried | Best idle-cost path for the NLQ notebook (still can't back a Bedrock KB). |

For cheaper idle behavior on the `db` path, modify the program to use
**Neptune Serverless** — set `engineVersion` to a Serverless-capable version
(1.2.0.1+) and add a `serverlessV2ScalingConfiguration` block to the
cluster; no separate `ClusterInstance` needed. The cluster scales to
near-zero when not queried. (Neptune Analytics has no serverless mode.)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required configuration variable 'neptune-min:keyName'` | Config not set on this stack AND `engine=db` | `pulumi config set keyName <name>` (only needed for `engine=db`) |
| `passphrase must be set with PULUMI_CONFIG_PASSPHRASE` | Local-mode secrets passphrase env var unset | `$env:PULUMI_CONFIG_PASSPHRASE = "<your-passphrase>"` |
| `incorrect passphrase` | Stack was created with a different passphrase | Delete + recreate the stack: `pulumi stack rm dev --yes; pulumi stack init dev` |
| `Missing region information` | AWS region not set in Pulumi config | `pulumi config set aws:region us-east-1` |
| `Unknown engine '<x>'` | Typo in `engine` config | Use `analytics` or `db`. `pulumi config set engine analytics` |
| `pulumi up` fails on `aws.neptune.Cluster` (db path) | Cluster endpoint / subnet group IDs not propagated, IAM perms | Check IAM perms include `neptune:CreateDBCluster`, `ec2:*` |
| `pulumi up` fails on `aws.neptunegraph.Graph` (analytics path) | IAM perms missing for Neptune Analytics | Check IAM perms include `neptune-graph:CreateGraph`, `neptune-graph:*`. No VPC perms needed. |
| `InvalidParameterValue ... Character sets beyond ASCII` (db path) | Em-dash or other non-ASCII in a security-group description | Already fixed in `index.ts` (uses ASCII `-` only). Re-pull if you hit this. |
| `ssh: connect to host ... port 22: Connection refused` (db path) | Bastion security group not allowing your IP, or your IP changed (DHCP) | Re-run the IP detection step (step 8) and `pulumi up` to refresh the SG |
| `ssh: Permission denied (publickey)` (db path) | Wrong private key file, or key file permissions too open | On Windows: `icacls <key> /inheritance:r /grant:r "$($env:USERNAME):(R)"` |
| 403 / AccessDenied on Neptune Analytics endpoint | IAM auth misconfigured in `graph_notebook_config` | Set `"auth_mode": "IAM"` and ensure `aws configure` ran with `neptune-graph:*` perms |
| TLS verification error when hitting localhost (db path) | Cert hostname mismatch through tunnel | Set `"ssl_verify": false` in `graph_notebook_config` |

## Engine cheat-sheet (which one to pick)

| You want... | Pick | Why |
|---|---|---|
| To back an **Amazon Bedrock Knowledge Base** with GraphRAG | `engine=analytics` | Only Neptune Analytics is in the Bedrock API enum (`NEPTUNE_ANALYTICS`). Neptune Database is rejected. |
| Cheapest possible **NLQ notebook** with idle scaling | `engine=db` + Neptune Serverless | Serverless database scaling is near-zero when not queried; Neptune Analytics has no serverless mode and bills per hour while the graph exists. |
| The simplest topology (no VPC, no bastion, no key pair) | `engine=analytics` | Public DNS endpoint + IAM auth — one resource, no other infra. |
| A private Neptune Database cluster | `engine=db` | Private VPC + bastion tunnel; can be made public with IAM but the bastion path is what graph-notebook's README documents. |
| The Neptune engine AWS SageMaker Workbench expects | `engine=db` | Workbench pre-provisions a Neptune Database cluster; the notebook's own assumption (cell 3's `if config.neptune_service == 'neptune-db'`) is for Database. |

## File map

```
.
├── Pulumi.yaml               — project metadata
├── Pulumi.dev.yaml.example   — sample stack config (copy to Pulumi.dev.yaml)
├── package.json
├── package-lock.json
├── tsconfig.json
├── index.ts                  — the Pulumi program (compiles cleanly for both engines)
├── setup.ps1                 — automated version of steps 6, 7, 8 (db-only)
├── node_modules/             — @pulumi/aws, @pulumi/pulumi (gitignored)
└── README.md                 — this file
```

If you'd rather skip steps 6–8 on the `engine=db` path, run `setup.ps1` (it
generates the keypair, imports to AWS, detects IPv4, sets all Pulumi config in
one go). On `engine=analytics` you don't need it — there's no key pair or IP.