import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

// ponytail: full docs in README.md. Engine toggle: `pulumi config set engine analytics|db`.

const cfg = new pulumi.Config();
const engine = cfg.get("engine") ?? "analytics";
if (!["analytics", "db"].includes(engine)) {
    throw new Error(`engine must be 'analytics' or 'db', got '${engine}'`);
}

let _endpoint: pulumi.Output<string>;
let _graphId: pulumi.Output<string> | undefined;
let _graphArn: pulumi.Output<string> | undefined;
let _bastionIp: pulumi.Output<string> | undefined;

if (engine === "analytics") {
    // ponytail: Neptune Analytics has no serverless mode, IAM auth is always on.
    // First pulumi up needs root to also create the IAM policy below.
    const graph = new aws.neptunegraph.Graph("neptune-graph", {
        graphName: "neptune-min",
        provisionedMemory: cfg.getNumber("provisionedMemory") ?? 16,
        deletionProtection: false,
        publicConnectivity: true,
        replicaCount: 0,
        vectorSearchConfiguration: {
            vectorSearchDimension: cfg.getNumber("vectorSearchDimension") ?? 1024,
        },
    });
    _endpoint = graph.endpoint;
    _graphId = graph.id;
    _graphArn = graph.arn;
} else {
    // engine=db — needs keyName + myIp config; bastion SSH tunnel required.
    const keyName = cfg.require("keyName");
    const myIp = cfg.require("myIp");

    const vpc = aws.ec2.getVpcOutput({ default: true });
    const subnets = aws.ec2.getSubnetsOutput({
        filters: [{ name: "vpc-id", values: [vpc.id] }],
    });

    const bastionSg = new aws.ec2.SecurityGroup("bastion-sg", {
        vpcId: vpc.id,
        description: "SSH bastion for Neptune tunnel",
        ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [myIp] }],
        egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    });

    const neptuneSg = new aws.ec2.SecurityGroup("neptune-sg", {
        vpcId: vpc.id,
        description: "Neptune writer - 8182 from bastion only",
        ingress: [{ protocol: "tcp", fromPort: 8182, toPort: 8182, securityGroups: [bastionSg.id] }],
        egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
    });

    const subnetGroup = new aws.neptune.SubnetGroup("neptune-subnet-group", {
        subnetIds: subnets.ids,
    });

    const cluster = new aws.neptune.Cluster("neptune-cluster", {
        clusterIdentifier: "neptune-min",
        engine: "neptune",
        neptuneSubnetGroupName: subnetGroup.name,
        vpcSecurityGroupIds: [neptuneSg.id],
        skipFinalSnapshot: true,
        deletionProtection: false,
    });

    new aws.neptune.ClusterInstance("neptune-0", {
        clusterIdentifier: cluster.clusterIdentifier,
        instanceClass: cfg.get("instanceClass") ?? "db.r5.large",
        engine: "neptune",
        neptuneSubnetGroupName: subnetGroup.name,
        applyImmediately: true,
    });

    const ami = aws.ec2.getAmiOutput({
        mostRecent: true, owners: ["amazon"],
        filters: [{ name: "name", values: ["al2023-ami-2023.*-x86_64"] }],
    });

    const bastion = new aws.ec2.Instance("bastion", {
        instanceType: "t3.micro",
        ami: ami.id,
        subnetId: subnets.ids.apply((ids: string[]) => ids[0]),
        vpcSecurityGroupIds: [bastionSg.id],
        keyName,
        associatePublicIpAddress: true,
        tags: { Name: "neptune-bastion" },
    });

    _endpoint = cluster.endpoint;
    _bastionIp = bastion.publicIp;
}

export const endpoint = _endpoint;
export const graphId = _graphId;
export const graphArn = _graphArn;
export const bastionIp = _bastionIp;
export const sshTunnelCommand = _bastionIp
    ? pulumi.interpolate`ssh -i ${cfg.get("keyName") ?? "key"}.pem -N -L 8182:${_endpoint}:8182 ec2-user@${_bastionIp}`
    : pulumi.output("");