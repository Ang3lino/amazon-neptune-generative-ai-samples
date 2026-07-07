# Networking — running the NLQ notebook against a private Neptune cluster

This documents the topology provisioned by `infra/pulumi/` and **why each piece
is required**. If `pulumi preview` succeeds, this is what gets created.

## Topology

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

## Why each piece is non-negotiable

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

## Alternative simpler topology — "public Neptune + IAM", no bastion

```
  Laptop
    |
    | HTTPS 8182 (SigV4-signed, IAM-auth required)
    v
+-----------------------+
| VPC                   |
|  Public subnet        |
|  +-----------------+  |
|  | Neptune cluster |  |   - publiclyAccessible = true
|  | (writer)        |  |   - SG neptune: in 8182 from 0.0.0.0/0
|  +-----------------+  |   - auth_mode: IAM (SigV4 on every request)
+-----------------------+
```

Smaller IaC, but every Neptune request has to be SigV4-signed (graph_notebook does this automatically when `auth_mode: IAM` in the config) and 8182 is internet-facing. Only safe if IAM auth is on — turning on `publiclyAccessible` *without* IAM auth is an open graph database.

## Runtime flow after `pulumi up`

```bash
# 1. Read outputs from the deployment
pulumi stack output neptuneEndpoint   # cluster hostname
pulumi stack output bastionPublicIp   # bastion IP
pulumi stack output sshTunnelCommand  # ready-to-paste command

# 2. Open the tunnel (keeps a terminal occupied)
ssh -i <keypair>.pem -N -L 8182:<neptuneEndpoint>:8182 ec2-user@<bastionPublicIp>

# 3. In the notebook, top cells in this order:
#    a) %load_ext graph_notebook.magics
#    b) %%graph_notebook_config with host=localhost, port=8182, ssl=true,
#                                 ssl_verify=false, neptune_service=neptune-db,
#                                 auth_mode=DEFAULT, aws_region=us-east-1
#    c) %seed --model property_graph --dataset airports --language opencypher --run
#    d) rest of the notebook as written
```

## Cost note

`db.r5.large` (smallest non-serverless Neptune instance) is roughly **$0.385/hr**
(~$280/mo if left running). Tear the stack down between sessions:

```bash
pulumi destroy
```

For cheaper idle behavior, switch the cluster to **Neptune Serverless** by setting
the engine version to a Serverless-capable version and adding a
`serverlessScalingConfiguration` block — no separate `ClusterInstance` needed,
and the cluster scales to near-zero when not queried.