import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/**
 * Minimum Neptune cluster + bastion SSH tunnel.
 *
 * Topology:
 *   Laptop --ssh:22--> Bastion (public subnet) --tcp:8182--> Neptune (private subnet)
 *
 * The laptop runs `ssh -i key.pem -N -L 8182:<neptune>:8182 ec2-user@<bastion>`
 * and graph_notebook points at `localhost:8182` instead of the private Neptune endpoint.
 *
 * Required config (`pulumi config set ...`):
 *   - keyName   : name of an existing EC2 keypair to SSH into the bastion
 *   - myIp      : your laptop's public IP, CIDR form (e.g. 203.0.113.10/32)
 *
 * Optional config:
 *   - instanceClass : Neptune instance class, default db.r5.large (smallest non-serverless)
 */

const cfg = new pulumi.Config();
const keyName = cfg.require("keyName");
const myIp = cfg.require("myIp"); // e.g. "203.0.113.10/32"
const instanceClass = cfg.get("instanceClass") ?? "db.r5.large";

// ---------------------------------------------------------------------------
// VPC / subnets — reuse the default VPC. Neptune requires its DB subnet
// group to span >=2 AZs; the default VPC satisfies that out of the box.
// ---------------------------------------------------------------------------
const vpc = aws.ec2.getVpcOutput({ default: true });
const vpcSubnets = aws.ec2.getSubnetsOutput({
  filters: [{ name: "vpc-id", values: [vpc.id] }],
});

// ---------------------------------------------------------------------------
// Security groups
// ---------------------------------------------------------------------------
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
  description: "Neptune writer — 8182 from bastion only",
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

// ---------------------------------------------------------------------------
// Neptune — subnet group + cluster + one instance
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Bastion EC2 — public IP, Amazon Linux 2023, lives in the first subnet
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Outputs — what you paste into graph_notebook / SSH
// ---------------------------------------------------------------------------
export const neptuneEndpoint = cluster.endpoint;
export const bastionPublicIp = bastion.publicIp;
export const sshTunnelCommand = pulumi.interpolate`
  # from your laptop, run:
  ssh -i ${keyName}.pem -N -L 8182:${cluster.endpoint}:8182 ec2-user@${bastion.publicIp}
  # then point graph_notebook_config host at "localhost" (port 8182 forwarded)
`;