import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/**
 * Minimum Neptune stack for running the NLQ notebook.
 *
 * Two engines are supported, selected by the `engine` config value:
 *
 *   - "analytics" (DEFAULT): Amazon Neptune Analytics graph.
 *     * Uses aws.neptunegraph.Graph
 *     * IAM auth is ALWAYS required by Neptune Analytics (AWS enforced)
 *     * publicConnectivity=true lets your laptop reach the public DNS endpoint
 *       directly — no bastion, no tunnel, no SSH needed.
 *     * No VPC, no key pair, no security groups required.
 *     * Best match for backing an Amazon Bedrock Knowledge Base (GraphRAG).
 *
 *   - "db": Amazon Neptune Database (Serverless-capable).
 *     * Uses aws.neptune.Cluster + ClusterInstance (r5.large by default)
 *     * Default auth mode is DEFAULT (no IAM) unless you set authMode="IAM"
 *     * Cluster is privately addressed; reach it via an SSH tunnel through
 *       a t3.micro bastion in the same VPC. KEY PAIR + your laptop IP required.
 *     * Best match for the NLQ notebook with cheapest idle scaling
 *       (switch instance to db.serverless + serverlessV2ScalingConfiguration).
 *
 * Switch with:  pulumi config set engine analytics   (or "db")
 * Default when unset: "analytics"
 *
 * The notebook itself works against either engine — see NETWORKING.md.
 *
 * Q: "Can I SSH into the Neptune instance?"
 * A: NEVER. Neptune (either engine) is a fully managed AWS service — not
 *    an EC2 instance you can log into. The bastion in the "db" path is YOUR
 *    EC2 to SSH to; the bastion then forwards traffic to Neptune's port 8182.
 *    In the "analytics" path with publicConnectivity=true there's no bastion
 *    either — you talk to the graph's public DNS hostname directly over HTTPS.
 */

const cfg = new pulumi.Config();
const engineCfg = cfg.get("engine") ?? "analytics";

// "db" path only — unused by "analytics":
const keyName = cfg.get("keyName") ?? "";                       // EC2 keypair name
const myIp = cfg.get("myIp") ?? "";                            // CIDR e.g. "203.0.113.10/32"
const instanceClass = cfg.get("instanceClass") ?? "db.r5.large";

// Holders filled by the chosen branch, exported at the bottom:
let _engine: pulumi.Output<string>;
let _endpoint: pulumi.Output<string>;
let _graphId: pulumi.Output<string> | undefined;
let _graphArn: pulumi.Output<string> | undefined;
let _bastionIp: pulumi.Output<string> | undefined;
let _sshTunnelCommand: pulumi.Output<string> | undefined;
let _noteForGraphNotebook: pulumi.Output<string>;

// ===========================================================================
// PATH A — Neptune Analytics (default)
// ===========================================================================
if (engineCfg === "analytics") {
    const vectorSearchDimension = cfg.getNumber("vectorSearchDimension") ?? 1024;
    const provisionedMemory = cfg.getNumber("provisionedMemory") ?? 16;

    /**
     * Neptune Analytics is a fully managed service. You can NEVER SSH into it.
     * It is not an EC2 instance in your account — AWS owns the runtime. With
     * publicConnectivity=true you just hit the graph's public DNS hostname
     * from your laptop over HTTPS:8182 with SigV4 authentication. graph_notebook
     * signs every request automatically when auth_mode="IAM" is set.
     */
    const graph = new aws.neptunegraph.Graph("neptune-graph", {
        graphName: "neptune-min",
        provisionedMemory: provisionedMemory,
        deletionProtection: false,
        publicConnectivity: true,
        replicaCount: 0,        // 0 = cheapest, slower recovery; set 1 for HA
        vectorSearchConfiguration: {
            vectorSearchDimension: vectorSearchDimension,
        },
        tags: {
            Environment: "development",
            Project: "neptune-nlq-notebook",
        },
    });

    _engine = pulumi.output("analytics");
    _endpoint = graph.endpoint;
    _graphId = graph.id;
    _graphArn = graph.arn;
    _noteForGraphNotebook = pulumi.interpolate`
        # The Neptune Analytics graph is publicly reachable. IAM auth is REQUIRED
        # by Neptune Analytics. In your notebook header cell, run:
        #   %load_ext graph_notebook.magics
        # Then:
        #   %%graph_notebook_config
        #   {
        #     "host": "${graph.endpoint}",
        #     "neptune_service": "neptune-graph",
        #     "port": 8182,
        #     "auth_mode": "IAM",
        #     "load_from_s3_arn": "",
        #     "ssl": true,
        #     "aws_region": "us-east-1"
        #   }
        # No bastion, no SSH tunnel - graph_notebook SigV4-signs every request directly.
        # Requires AWS creds with neptune-graph:* perms in the region.
        # For Bedrock KB GraphRAG: the KB Pull takes graph ARN as the vector store.
    `;
}

// ===========================================================================
// PATH B — Neptune Database (only when engine=="db")
// ===========================================================================
else if (engineCfg === "db") {
    if (!keyName || !myIp) {
        throw new Error(
          "engine='db' requires keyName and myIp config. " +
          "Run: pulumi config set keyName <ec2-keypair-name> ; pulumi config set myIp '<your-ipv4>/32'"
        );
    }

    // Reuse the default VPC. Neptune requires its DB subnet group to span >=2 AZs;
    // the default VPC satisfies that out of the box.
    const vpc = aws.ec2.getVpcOutput({ default: true });
    const vpcSubnets = aws.ec2.getSubnetsOutput({
      filters: [{ name: "vpc-id", values: [vpc.id] }],
    });

    // Bastion: SSH open to *your* IP only. Egress open so the tunnel can reach Neptune.
    const bastionSg = new aws.ec2.SecurityGroup("bastion-sg", {
      vpcId: vpc.id,
      description: "SSH bastion for Neptune tunnel",
      ingress: [{
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        cidrBlocks: [myIp],
      }],
      egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
      }],
    });

    // Neptune: 8182 only from the bastion security group (reference by id, not CIDR).
    const neptuneSg = new aws.ec2.SecurityGroup("neptune-sg", {
      vpcId: vpc.id,
      description: "Neptune writer - 8182 from bastion only",
      ingress: [{
        protocol: "tcp",
        fromPort: 8182,
        toPort: 8182,
        securityGroups: [bastionSg.id],
      }],
      egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
      }],
    });

    const subnetGroup = new aws.neptune.SubnetGroup("neptune-subnet-group", {
      subnetIds: vpcSubnets.ids,
      description: "Spans >=2 AZs as required by Neptune",
    });

    const cluster = new aws.neptune.Cluster("neptune-cluster", {
      clusterIdentifier: "neptune-min",
      engine: "neptune",
      neptuneSubnetGroupName: subnetGroup.name,
      vpcSecurityGroupIds: [neptuneSg.id],
      skipFinalSnapshot: true,
      deletionProtection: false,
    });

    const instance = new aws.neptune.ClusterInstance("neptune-0", {
      clusterIdentifier: cluster.clusterIdentifier,
      instanceClass: instanceClass,
      engine: "neptune",
      neptuneSubnetGroupName: subnetGroup.name,
      applyImmediately: true,
    });

    const ami = aws.ec2.getAmiOutput({
      mostRecent: true,
      owners: ["amazon"],
      filters: [{ name: "name", values: ["al2023-ami-2023.*-x86_64"] }],
    });

    const bastion = new aws.ec2.Instance("bastion", {
      instanceType: "t3.micro",
      ami: ami.id,
      subnetId: vpcSubnets.ids.apply((ids: string[]) => ids[0]),
      vpcSecurityGroupIds: [bastionSg.id],
      keyName: keyName,
      associatePublicIpAddress: true,
      tags: { Name: "neptune-bastion" },
    });

    _engine = pulumi.output("db");
    _endpoint = cluster.endpoint;
    _bastionIp = bastion.publicIp;
    _sshTunnelCommand = pulumi.interpolate`
      # from your laptop, run:
      ssh -i ${keyName}.pem -N -L 8182:${cluster.endpoint}:8182 ec2-user@${bastion.publicIp}
      # then point graph_notebook_config host at "localhost" (port 8182 forwarded)
      # neptune_service: "neptune-db", auth_mode: "DEFAULT", ssl: true, ssl_verify: false
    `;
    _noteForGraphNotebook = pulumi.interpolate`
      # In your notebook header cell run:
      #   %load_ext graph_notebook.magics
      # Then:
      #   %%graph_notebook_config
      #   {
      #     "host": "localhost",
      #     "neptune_service": "neptune-db",
      #     "port": 8182,
      #     "auth_mode": "DEFAULT",
      #     "load_from_s3_arn": "",
      #     "ssl": true,
      #     "ssl_verify": false,
      #     "aws_region": "us-east-1"
      #   }
      # Open the SSH tunnel first; ssl_verify false because the tunnel breaks hostname match.
    `;
}

else {
    throw new Error(`Unknown engine '${engineCfg}'. Use 'analytics' (default) or 'db'.`);
}

// ===========================================================================
// Stack outputs (top-level exports — Pulumi surfaces these as stack outputs)
// ===========================================================================
export const engine = _engine;
export const endpoint = _endpoint;
export const graphId = _graphId;
export const graphArn = _graphArn;
export const bastionIp = _bastionIp;
export const sshTunnelCommand = _sshTunnelCommand;
export const noteForGraphNotebook = _noteForGraphNotebook;