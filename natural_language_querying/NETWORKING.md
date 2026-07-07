# Networking — Neptune for the NLQ notebook

This documents the two topologies provisioned by `infra/pulumi/` and **why each
piece is required**. The Pulumi program picks a topology based on the
`engine` config value:

| `engine` config | Engine | Topology | Bastion required? | Auth mode |
|---|---|---|---|---|
| `analytics` (default) | Amazon Neptune Analytics (`aws.neptunegraph.Graph`) | Public endpoint, IAM-signed TLS | **No** | IAM (always — AWS enforced) |
| `db` | Amazon Neptune Database (`aws.neptune.Cluster` + `ClusterInstance`) | Private VPC + bastion tunnel | **Yes** | DEFAULT or IAM (configurable) |

If `pulumi preview` succeeds, the listed resources get created.

## Topology A — `engine=analytics` (default)

```
+--------------------------------------------------------------------+
|  YOUR LAPTOP (Windows / VSCode + Jupyter in .venv)                 |
|                                                                     |
|   graph_notebook --SigV4-signed HTTPS--> g-xxxxxx                  |
|                                            .neptune-graph            |
|                                            .amazonaws.com:8182       |
+------------------------------+-------------------------------------+
                               |  HTTPS 8182
                               |  over public Internet
                               |  every request SigV4-signed
                               v
+--------------------------------------------------------------------+
|  AWS Region (e.g. us-east-1)                                        |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |  AWS-managed Neptune Analytics graph (g-xxxxxx)              |  |
|  |                                                              |  |
|  |  - public DNS endpoint (publicConnectivity: true)            |  |
|  |  - IAM auth REQUIRED on every request (cannot be turned off) |  |
|  |  - provisionedMemory m-NCU (billed per hour while graph live) |  |
|  |  - NOT an EC2 instance → you CANNOT SSH into it              |  |
|  |  - replicaCount=0 → no failover replica (cheapest);          |  |
|  |    set replicaCount=1 for HA (extra hourly cost)              |  |
|  |  - vectorSearchConfiguration (1024 dims default)              |  |
|  +--------------------------------------------------------------+  |
|                                                                    |
|  No VPC, no subnets, no security groups, no bastion, no key pair —  |
|  AWS owns the runtime entirely.                                    |
+--------------------------------------------------------------------+
```

### Why this is far simpler than the database topology

| Piece | Required because | What fails if you skip it |
|---|---|---|
| `aws.neptunegraph.Graph` resource | The actual Neptune Analytics graph — there's nothing else to create | No graph → no endpoint → notebook can't connect |
| `publicConnectivity: true` | Lets your laptop reach the public DNS hostname directly | With `false`, you'd need a `PrivateGraphEndpoint` in a VPC + bastion (back to topology B-like complexity) |
| `vectorSearchConfiguration{ vectorSearchDimension: 1024 }` | Mandatory for GraphRAG / Bedrock KB; the value must match your embedding model's output dim (Titan v2 = 1024, Titan v1 = 1536, etc.) | Bedrock KB creation against this graph will fail without a vector index matching the chosen embedding |
| IAM auth (always on) | AWS enforced — Neptune Analytics serves no plaintext-TLS requests, no anonymous ones | DEFAULT auth mode → all queries 403 |
| **Nothing else** | Neptune Analytics is fully managed — no VPC, no subnets, no SGs, no instance class | Na |

### What you CANNOT do

- **You can't SSH into a Neptune Analytics graph.** It is not an EC2 instance in your account. AWS owns the runtime. The only way to reach it is over HTTPS:8182 with SigV4-signed requests.
- **You don't need a bastion when `publicConnectivity=true`.** graph_notebook hits the public hostname directly.
- **You can't get cheaper idle** — Neptune Analytics is per-hour billing with NO serverless scaling. `pulumi destroy` between sessions to fully stop the bill.

## Topology B — `engine=db`

```
+--------------------------------------------------------------------+
|  YOUR LAPTOP (Windows / VSCode + Jupyter in .venv)                 |
|                                                                     |
|   graph_notebook --https--> localhost:8182                          |
|                              |                                      |
|                              | (loopback — port forward)            |
|                       ssh -N -L 8182:<neptune>:8182 \               |
|                           -i key.pem ec2-user@<bastion-ip>          |
|                              |                                      |
+------------------------------+-------------------------------------+
                               |  TCP 22, SSH-encrypted
                               |  over public Internet
                               v
+--------------------------------------------------------------------+
|  AWS Region (e.g. us-east-1)                                        |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |  VPC  (default)                                              |  |
|  |                                                              |  |
|  |   Internet Gateway (IGW)  <--route 0.0.0.0/0--              |  |
|  |           ^                                                  |  |
|  |           |                                                  |  |
|  |   +-------+-------------------------+                        |  |
|  |   | PUBLIC subnet  (AZ-a)           |                        |  |
|  |   |                                 |                        |  |
|  |   |  EC2 bastion                    |                        |  |
|  |   |   - public IP                   |                        |  |
|  |   |   - SG bastion:                 |                        |  |
|  |   |       in  22 from <your-ip>/32 |                        |  |
|  |   |       out any                   |                        |  |
|  |   +-------+-------------------------+                        |  |
|  |           |  (private IP routing; no public IP on Neptune)   |  |
|  |           v                                                  |  |
|  |   +-------+-------------------------+   +------------------+  |  |
|  |   | PRIVATE subnet (AZ-a)        |   | PRIVATE subnet   |  |  |
|  |   |                              |   | (AZ-b)            |  |  |
|  |   | Neptune writer               |   | Neptune reader   |  |  |
|  |   |   - port 8182 (TLS)          |   |  (HA / failover) |  |  |
|  |   |   - no public IP             |   |                  |  |  |
|  |   |   - SG neptune:              |   |                  |  |  |
|  |   |     in 8182 from bastion-SG |   |                  |  |  |
|  |   +-------+---------------------+    +------+-----------+  |  |
|  |           |                               |              |  |
|  |           +------- DB Subnet Group --------+              |  |
|  |                  (spans >=2 AZs)                          |  |
|  +-----------------------------------------------------------+  |
+--------------------------------------------------------------------+
```

### Why each piece in topology B is non-negotiable

| Piece | Required because | What fails if you skip it |
|---|---|---|
| **VPC** | Neptune is a VPC-only service; it cannot run outside a VPC. | `CreateDBCluster` rejects any request without a `DBSubnetGroupName` rooted in a VPC. |
| **≥2 private subnets in different AZs** | Neptune's `DBSubnetGroup` API **requires** the group to span ≥2 AZs — Neptune needs a writer + a failover target. | `DBSubnetGroup does not cover 2 Availability Zones` at cluster creation. The default VPC satisfies this; a custom VPC must too. |
| **DB Subnet Group** | A named handle Neptune references; the cluster + every instance in it must point at one. | `aws.neptune.Cluster` rejects a cluster without `neptuneSubnetGroupName`. |
| **Internet Gateway + public subnet** | The bastion needs a public IP to be SSH-reachable from your laptop; private Neptune doesn't have one. | SSH hangs / connection refused. |
| **Bastion EC2 (or any TCP forwarder)** | Neptune instances ship with `publiclyAccessible=false` and have **no public IP**. The private IP `10.0.x.x` is unroutable from your laptop → you need a host with one foot in each network (public IP on the laptop side, private IP on the Neptune side). | `%graph_notebook_config`'s `host` resolves to a private IP and traffic times out. |
| **SSH port forward `-L 8182:<neptune>:8182`** | The SSH client bridges loopback to Neptune's private IP; avoids putting a public IP on Neptune. | Without it, Neptune receives no traffic — the laptop can't route to `10.x.x.x`. |
| **SG on bastion: inbound 22 from your IP only** | Smallest blast radius for an internet-facing SSH endpoint. | Open 22 to `0.0.0.0/0` → constant credential-stuffing bots. Fail any security review. |
| **SG on Neptune: inbound 8182 from bastion SG (NOT a CIDR)** | 8182 is the HTTPS+WSS port Neptune serves Gremlin/openCypher/SPARQL/Loader `%seed` on. Limit to the bastion's security-group ID (`SourceSecurityGroupId`, not a CIDR). | Open to `0.0.0.0/0` → anyone with a route to the VPC can probe Neptune (Neptune is auth-optional by default — this is wide-open). |
| **TLS on 8182** (`"ssl": true` in `%graph_notebook_config`) | Neptune's 8182 is HTTPS-only; plaintext is rejected. The SSH tunnel doesn't substitute for this — TLS is end-to-end from the client to Neptune; only the TCP transport is forwarded. | Connection reset by peer. |
| **`%graph_notebook_config` host = bare cluster hostname** (strip the `https://`) | `graph_notebook` builds URLs as `https://<host>:<port>/...` — including `https://` in `host` produces `https://https://...`. | Malformed URL, HTTP errors instead of query results. |
| **`"ssl_verify": false` when tunnelling via `localhost`** | The cert on `localhost:8182` doesn't match the cluster's hostname; the tunnel breaks hostname matching. Safe enough for a local notebook session — tighten in production. | TLS verification error in `graph_notebook`. |

### What you CANNOT do with Neptune Database

- **You can't SSH into a Neptune Database cluster.** Same as Analytics — Neptune is a managed graph database service, not an EC2 instance. The bastion is YOUR EC2; SSH lands there, not on Neptune.
- **You can't make a Neptune Database cluster public.** `publiclyAccessible=false` is enforced (with rare deprecated exceptions not worth using) — even if the property exists, AWS recommends against setting it true.
- **You can't use Neptune Database as a Bedrock KB vector store.** Only Neptune Analytics is in the Bedrock API enum. (See top-level README for the doc references.)

## A side-by-side capability summary

| Capability | Neptune Analytics (`engine=analytics`) | Neptune Database (`engine=db`) |
|---|---|---|
| Backs a Bedrock Knowledge Base via GraphRAG | ✅ Only Neptune engine that can | ❌ Not in the Bedrock API enum |
| Runs the NLQ notebook (LangChain Text-to-Cypher) | ✅ Works (cell 3 `else` branch with `NeptuneAnalyticsGraph`) | ✅ Works (cell 3 `if` branch with `NeptuneGraph`) |
| Has a Serverless mode (near-zero idle cost) | ❌ No serverless — per-hour billing while graph live | ✅ `db.serverless` scales between MinCapacity=1 and MaxCapacity=128 NCU; near-zero when idle |
| Public endpoint reachable from laptop | ✅ `publicConnectivity: true` makes DNS public | ❌ No public IP — must tunnel via bastion |
| Auth | IAM enforced (always) | DEFAULT or IAM (configurable) |
| You can SSH into it | ❌ Never — fully managed AWS runtime | ❌ Never — fully managed AWS runtime |
| Smallest useful instance | 16 m-NCU (32+ in some regions) | `db.r5.large` or `db.serverless` |
| Per-hour cost when idle (rough) | Always per-hour, no idle scaling | Provisioned: $0.385/hr `db.r5.large`; Serverless: ~$0 when not queried |
| %seed command works on it | ✅ Yes (`--language opencypher`) | ✅ Yes (`--language opencypher`) |

## Runtime flow — `engine=analytics` (no bastion)

```bash
# 1. Apply
pulumi up

# 2. Read outputs
pulumi stack output endpoint      # g-xxxxxx.us-east-1.neptune-graph.amazonaws.com
pulumi stack output graphId       # g-xxxxxxxxxx
pulumi stack output graphArn      # arn:aws:neptune-graph:us-east-1:123456789012:graph/g-xxxxxxxxxx
pulumi stack output noteForGraphNotebook

# 3. In the notebook, top cells in this order:
#    a) %load_ext graph_notebook.magics
#    b) %%graph_notebook_config with host=<endpoint above>, port=8182,
#                                 neptune_service="neptune-graph",
#                                 auth_mode="IAM",
#                                 ssl=true,
#                                 aws_region=us-east-1
#    c) %seed --model property_graph --dataset airports --language opencypher --run
#       (for Bedrock GraphRAG you don't %seed; the KB ingestion loads the graph instead)
#    d) rest of the notebook as written
```

## Runtime flow — `engine=db` (with bastion)

```bash
# 1. Apply
pulumi up

# 2. Read outputs
pulumi stack output endpoint         # neptune-min.cluster-xxx.neptune.amazonaws.com
pulumi stack output bastionIp        # public IP of bastion EC2
pulumi stack output sshTunnelCommand # ready-to-paste one-liner

# 3. Open the tunnel (separate terminal — stays open while you use Neptune)
ssh -i <keypair>.pem -N -L 8182:<endpoint>:8182 ec2-user@<bastionIp>

# 4. In the notebook:
#    a) %load_ext graph_notebook.magics
#    b) %%graph_notebook_config with host=localhost, port=8182,
#                                 neptune_service="neptune-db",
#                                 auth_mode="DEFAULT", ssl=true, ssl_verify=false,
#                                 aws_region=us-east-1
#    c) %seed --model property_graph --dataset airports --language opencypher --run
#    d) rest of the notebook as written
```

## Alternative simpler topology for the db path — "public Neptune + IAM", no bastion

```
  Laptop
    |
    | HTTPS 8182 (SigV4-signed, IAM-auth required)
    v
+-----------------------+
| VPC                   |
|  Public subnet        |
|  +-----------------+  |
|  | Neptune cluster |  |   - publiclyAccessible = true (NOT recommended)
|  | (writer)        |  |   - SG neptune: in 8182 from 0.0.0.0/0
|  +-----------------+  |   - auth_mode: IAM (mandatory if going public)
+-----------------------+
```

Smaller IaC, but every Neptune request has to be SigV4-signed (`auth_mode: IAM`) and 8182 is internet-facing. Only safe if IAM auth is on — turning on `publiclyAccessible` *without* IAM auth is an open graph database. Not implemented in the current Pulumi program; the bastion version is what graph-notebook's own README documents as the recommended local-connection setup.

## Cost cheat-sheet

| Resource | Rough on-demand hourly (`us-east-1`) |
|---|---|
| Neptune Analytics graph, 16 m-NCU (smallest) | ~$0.16–$0.20/hr |
| Neptune Database `db.r5.large` (smallest non-serverless) | ~$0.385/hr → ~$280/mo if left running |
| Neptune Database `db.serverless` (Serverless, idle MinCapacity=1 NCU) | Near-zero when not queried |
| Bastion EC2 `t3.micro` | ~$0.005/hr → ~$8/mo if left running |

**Tear the stack down between sessions** with `pulumi destroy` to avoid surprises. For analytics the graph itself is the variable cost; for db the cluster/instance is. There is no idle scaling on Neptune Analytics — destroy is the only way to stop the bill between uses.