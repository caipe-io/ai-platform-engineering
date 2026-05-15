---
sidebar_position: 1
---

# Run CAIPE on Amazon EKS

This guide walks you through creating an **Amazon EKS** (Elastic Kubernetes Service) cluster and deploying **CAIPE** (Community AI Platform Engineering) on it. No prior experience with CAIPE or EKS is required.

**What is EKS?** EKS is AWS’s managed Kubernetes service. You get a production-ready cluster without managing control-plane nodes yourself. **eksctl** is a simple CLI to create and manage EKS clusters with sensible defaults.

**What you’ll do:** Create an EKS cluster, install ArgoCD (optional, for GitOps-style deploys), then deploy CAIPE using the Helm chart. You’ll need an AWS account and the tools listed below.

---

## Step 1: Clone the repository

You need the repo to use the EKS cluster configuration example and to follow the same paths as this guide.

```bash
git clone https://github.com/caipe-io/ai-platform-engineering.git
cd ai-platform-engineering
```

The EKS config example lives under `deploy/eks/`. We’ll use it in a later step.

---

## Step 2: Prerequisites

Install and configure these before creating the cluster:

| Tool | Purpose |
|------|---------|
| **AWS CLI** | Authenticate to AWS and run commands ([install](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)) |
| **eksctl** | Create and manage EKS clusters ([install](https://eksctl.io/installation/)) |
| **kubectl** | Talk to your Kubernetes cluster ([install](https://kubernetes.io/docs/tasks/tools/)) |
| **Helm** | Install CAIPE and add-ons ([install](https://helm.sh/docs/intro/install/)) |

**AWS account:** Your user or role needs permissions for EC2, EKS, CloudFormation, and IAM (for cluster and node creation). See [Required AWS permissions](#required-aws-permissions) below.

---

## Step 3: Configure AWS credentials

Log in to AWS and confirm your identity:

```bash
# Configure AWS CLI (you’ll be prompted for Access Key ID and Secret)
aws configure

# Confirm credentials work
aws sts get-caller-identity

# Optional: set a default region
export AWS_DEFAULT_REGION=us-east-2
```

Use the same region in the next step when you create the cluster.

---

## Step 4: Create the EKS cluster

The repo includes a cluster config using EKS Auto Mode, which manages node provisioning via the built-in Karpenter controller. No additional autoscaler setup is required.

### Create a KMS key for secrets encryption

The cluster config encrypts Kubernetes secrets at rest using a customer-managed KMS key. Run this block in full each time you create the cluster. It always starts from the example file (with a fresh placeholder), and creates a new key, so it is safe to re-run after a previous cluster has been torn down:

```bash
# Always start from the example so the ARN placeholder is fresh
cp deploy/eks/dev-eks-cluster-config.yaml.example dev-eks-cluster-config.yaml

# Create a new key and capture its ARN
KEY_ARN=$(aws kms create-key \
  --description "dev-eks-cluster secrets encryption" \
  --query KeyMetadata.Arn --output text)

# Recreate the alias (delete first in case it exists from a previous run)
aws kms delete-alias --alias-name alias/dev-eks-cluster-secrets 2>/dev/null || true
aws kms create-alias \
  --alias-name alias/dev-eks-cluster-secrets \
  --target-key-id "$KEY_ARN"

# Write the new ARN into the config
sed -i "s|arn:aws:kms:us-east-2:ACCOUNT_ID:key/KEY_ID|$KEY_ARN|" dev-eks-cluster-config.yaml
```

Also update `publicAccessCIDRs` in the config to restrict API server access to your VPN or office CIDR before continuing.

### Run eksctl

Create the cluster. This usually takes **10–15 minutes**:

```bash
eksctl create cluster -f dev-eks-cluster-config.yaml
```

If you see a "CloudFormation stack already exists" error, see [Troubleshooting](#cloudformation-stack-already-exists).

eksctl will:

- Create a VPC and subnets
- Set up the EKS control plane
- Run `aws eks update-kubeconfig --region us-east-2 --name dev-eks-cluster` to configure your `kubectl` context to use the new cluster

### Verify the cluster

```bash
# List EKS clusters
eksctl get cluster

# Check that nodes are ready
kubectl get nodes

# Cluster and API server info
kubectl cluster-info

# Optional: list add-ons and system pods
eksctl get addons --cluster dev-eks-cluster
kubectl get pods -n kube-system
```

Once `kubectl get nodes` shows nodes in `Ready` state, continue to the next step.

### Grant additional IAM access

The cluster config uses `authenticationMode: API`, meaning cluster access is managed via **IAM access entries**, not the `aws-auth` ConfigMap. To grant another IAM user or role admin access, use `eksctl create accessentry`:

```bash
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Grant an IAM user cluster-admin access
IAM_USER=USERNAME
eksctl create accessentry \
  --cluster dev-eks-cluster \
  --principal-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:user/${IAM_USER}" \
  --kubernetes-group system:masters

# Grant an IAM role cluster-admin access (e.g. a CI/CD role)
IAM_ROLE=ROLE_NAME
eksctl create accessentry \
  --cluster dev-eks-cluster \
  --principal-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${IAM_ROLE}" \
  --kubernetes-group system:masters
```

Do not edit the `aws-auth` ConfigMap directly, as it has no effect in API auth mode.

---

## Step 5 (Optional): Configure node tiers with NodePools

By default, Auto Mode places all workloads on its built-in `general-purpose` pool. Apply the custom NodePools to right-size nodes per workload tier (Spot compute-optimised instances for agents, on-demand memory-optimised instances for RAG), and allow idle agent and RAG nodes to scale to zero.

| NodePool | Workloads | Instance strategy |
| -------- | --------- | ----------------- |
| `agents` | All `agent-*` subcharts | Spot-preferred, compute-optimised (`c5`/`m5`/`m6i`) |
| `rag` | `rag-server`, `agent-ontology`, `neo4j`, `milvus` | On-demand, memory-optimised (`r5`/`r6i`) |

```bash
kubectl apply -f deploy/eks/karpenter/
```

Verify the NodePools are created and the built-in Auto Mode pools are present:

```bash
kubectl get nodepool
```

When deploying CAIPE in the next step, append `-f charts/ai-platform-engineering/values-karpenter.yaml` to the Helm install command to route workloads to the correct node tier.

---

## Step 6: Deploy CAIPE on EKS

You have two main options:

### Option A: Install CAIPE with Helm

Install the CAIPE Helm chart directly on the cluster. Configure secrets and LLM settings as described in the Helm guide.

```bash
helm upgrade --install ai-platform-engineering oci://ghcr.io/caipe-io/charts/ai-platform-engineering \
  --version 1.1.0 \
  --namespace ai-platform-engineering \
  --create-namespace \
  --set-string tags.caipe-ui=true \
  --set-string tags.dynamic-agents=true \
  --set-string tags.mcp-netutils=true
```

Then:

- [Configure Agent Secrets](./configure-agent-secrets) for the agents you enabled
- [Configure LLMs](./configure-llms) for your chosen provider (Claude, OpenAI, etc.)

Full details: [Deploy CAIPE with Helm](/docs/getting-started/helm/setup).

### Option B: Use ArgoCD, then deploy CAIPE

ArgoCD keeps your cluster in sync with Git (or Helm) and is useful for ongoing updates. You can install ArgoCD first, then deploy the CAIPE chart through ArgoCD or Helm.

**Install ArgoCD on the cluster:**

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**Access the ArgoCD UI (optional):**

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Open http://localhost:8080. Then deploy CAIPE via the Helm chart (as in Option A) or by defining an ArgoCD Application that points at the same chart. See the [Helm deployment guide](../helm/setup.md) for the chart values and verification steps.

---

## Step 7 (Recommended): Install AWS Load Balancer Controller

For production-style ingress (e.g. LoadBalancer services), install the AWS Load Balancer Controller:

```bash
# Create IAM service account for the controller
eksctl create iamserviceaccount \
  --cluster=dev-eks-cluster \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess \
  --approve

# Add the EKS chart repo and install the controller
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=dev-eks-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller

# Verify
kubectl get deployment -n kube-system aws-load-balancer-controller
```

Use your actual cluster name if it’s not `dev-eks-cluster` (match the name in `dev-eks-cluster-config.yaml`).

---

## Required AWS permissions

Your AWS user or role needs permissions for:

- **EC2** — Instances, VPC, subnets, security groups
- **EKS** — Cluster and node group management
- **CloudFormation** — Stacks created by eksctl
- **IAM** — Roles and policies for the cluster and node groups

If something fails with “access denied”, check [IAM permissions for eksctl](https://eksctl.io/usage/minimum-iam-policies/) and your organisation’s policies.

---

## Troubleshooting

### Insufficient permissions

```bash
aws iam get-user
aws iam list-attached-user-policies --user-name YOUR_USERNAME
```

Fix by attaching the required policies or using a role that has them.

### Region mismatch

Ensure the region in `dev-eks-cluster-config.yaml` matches your AWS CLI default:

```bash
aws configure get region
```

### Node group creation fails

- Inspect CloudFormation:  
  `aws cloudformation describe-stack-events --stack-name eksctl-dev-cluster-nodegroup-worker-nodes`
- Check EC2 limits:  
  `aws ec2 describe-account-attributes --attribute-names supported-platforms`

### CloudFormation stack already exists

A previous cluster creation attempt failed and left a partial stack behind. Delete it before retrying:

```bash
aws cloudformation delete-stack --stack-name eksctl-dev-eks-cluster-cluster
aws cloudformation wait stack-delete-complete --stack-name eksctl-dev-eks-cluster-cluster
```

### TerminationProtection is enabled

eksctl enables CloudFormation termination protection on successfully created clusters. Disable it before deleting:

```bash
aws cloudformation update-termination-protection \
  --no-enable-termination-protection \
  --stack-name eksctl-dev-eks-cluster-cluster
```

Then retry the delete command.

### kubectl can’t reach the cluster

```bash
# Refresh kubeconfig for your cluster (use your region and cluster name)
aws eks update-kubeconfig --region us-east-2 --name dev-eks-cluster

# Confirm current context
kubectl config current-context
```

---

## Cleanup

When you’re done, delete the cluster to avoid ongoing AWS charges. eksctl enables CloudFormation termination protection on successfully created clusters, so disable it first:

```bash
aws cloudformation update-termination-protection \
  --no-enable-termination-protection \
  --stack-name eksctl-dev-eks-cluster-cluster

eksctl delete cluster -f dev-eks-cluster-config.yaml
```

Verify that CloudFormation stacks are gone:

```bash
aws cloudformation list-stacks --query 'StackSummaries[?contains(StackName, `eksctl-dev-cluster`)].{Name:StackName,Status:StackStatus}'
```

**Important:** Always tear down the cluster when you’re not using it to prevent unexpected charges.

### Clean up CloudWatch logs

EKS does not delete the control plane log group when the cluster is deleted. Remove it manually:

```bash
aws logs delete-log-group --log-group-name /aws/eks/dev-eks-cluster/cluster
```

### Clean up the KMS key

KMS keys cannot be deleted immediately; They must be scheduled for deletion with a minimum 7-day waiting period. Delete the alias first, then schedule the key:

```bash
# Look up the key ARN via the alias
KEY_ARN=$(aws kms describe-key \
  --key-id alias/dev-eks-cluster-secrets \
  --query KeyMetadata.Arn --output text)

aws kms delete-alias --alias-name alias/dev-eks-cluster-secrets

aws kms schedule-key-deletion \
  --key-id "$KEY_ARN" \
  --pending-window-in-days 7
```

The key will be permanently deleted after the pending window. You can cancel before then with `aws kms cancel-key-deletion --key-id "$KEY_ARN"`.

---

## Next steps

- [Configure Agent Secrets](./configure-agent-secrets) — Secrets for GitHub, ArgoCD, and other agents
- [Configure LLMs](./configure-llms) — LLM provider and API keys for CAIPE
- [Deploy CAIPE with Helm](/docs/getting-started/helm/setup) — Chart options, tags, and values
- [Run with KinD](/docs/getting-started/kind/setup) — Local one-command setup without AWS
