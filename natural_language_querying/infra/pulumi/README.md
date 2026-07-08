# Neptune-min infra (Pulumi, TypeScript)

Minimum Neptune for the `Natural_Language_Querying_LangChain_openCypher.ipynb` notebook. Toggle engines with `pulumi config set engine analytics|db`.

| `engine` | Resource | Bastion | Auth | Bedrock KB |
|---|---|---|---|---|
| `analytics` (default) | `aws.neptunegraph.Graph` | No | IAM (AWS-enforced) | Yes |
| `db` | `aws.neptune.Cluster` + bastion | Yes | DEFAULT | No |

Networking rationale: [`../NETWORKING.md`](../NETWORKING.md).

## Prerequisites

- Pulumi CLI v3+, AWS CLI v2, Node.js 20+, ssh-keygen (only for `engine=db`)
- `aws configure` on a user with `neptune-graph:*` (analytics) or `ec2:*` + `neptune:*` (db). For analytics, `AmazonNeptuneFullAccess` AWS-managed policy is enough; if `TagResource` 403s, attach a custom inline `neptune-graph:*` policy instead — see `index.ts` exports.

## Setup (from this dir)

```powershell
pulumi login --local
$env:PULUMI_CONFIG_PASSPHRASE = "<pick-a-passphrase>"
pulumi stack init dev
pulumi config set aws:region us-east-1
pulumi config set engine analytics   # or "db"
```

### If `engine=db` only — key pair + your IP

```powershell
ssh-keygen -t rsa -b 4096 -N '""' -f "$HOME/.ssh/neptune-min-key" -C "neptune-min"
aws ec2 import-key-pair --region us-east-1 --key-name neptune-min-key `
  --public-key-material "fileb://$HOME/.ssh/neptune-min-key.pub" --query KeyPairId --output text
pulumi config set keyName neptune-min-key
pulumi config set myIp "$((Invoke-WebRequest -UseBasicParsing 'https://api.ipify.org').Content)/32"
```

## Deploy

```powershell
pulumi up        # analytics: ~5-10 min, 1 resource; db: ~10-15 min, 7 resources
```

## Outputs

```powershell
pulumi stack output endpoint       # graph DNS (analytics) or cluster endpoint (db)
pulumi stack output graphId        # analytics only
pulumi stack output graphArn       # analytics only — pass to Bedrock KB
pulumi stack output bastionIp      # db only
pulumi stack output sshTunnelCommand # db only
```

## Notebook config

```python
%load_ext graph_notebook.magics
```

```python
# analytics:
%%graph_notebook_config
{
  "host": "<endpoint from stack output>",
  "neptune_service": "neptune-graph",
  "port": 8182,
  "auth_mode": "IAM",
  "load_from_s3_arn": "",
  "ssl": true,
  "aws_region": "us-east-1"
}

# db (run sshTunnelCommand first, then point at localhost):
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

`%seed --model property_graph --dataset airports --language opencypher --run` loads the air-routes dataset into either engine. Run cells top-to-bottom after.

## Teardown

```powershell
pulumi destroy --yes
pulumi stack rm dev --yes
# db only — key pair is not managed by Pulumi:
aws ec2 delete-key-pair --region us-east-1 --key-name neptune-min-key
```

Neptune Analytics bills per-hour while the graph exists (no idle scaling). `db` with `db.r5.large` costs ~$0.385/hr. Always destroy between sessions.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required configuration variable 'neptune-min:keyName'` | set keyName + myIp (only for engine=db) |
| `passphrase must be set` | `$env:PULUMI_CONFIG_PASSPHRASE = "..."` |
| `403 neptune-graph:CreateGraph` / `TagResource` | attach inline `neptune-graph:*` policy to your IAM user |
| `ConflictException: Graph already exists` | graph is orphaned from a killed `pulumi up`; `pulumi import aws:neptunegraph/graph:Graph neptune-graph <g-xxxxxxxxxxxx> --yes` then `pulumi state unprotect <URN> --yes` |
| `ssh: Permission denied (publickey)` (db) | `icacls <key> /inheritance:r /grant:r "$($env:USERNAME):(R)"` |
| `Undefined value` warnings (bastion/graph outputs) | expected on opposite engine branch; ignore |