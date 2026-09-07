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

The repo includes an example cluster config. Copy it and adjust the region or other settings if needed.

```bash
# From the repo root
cp deploy/eks/dev-eks-cluster-config.yaml.example dev-eks-cluster-config.yaml

# Edit if you need to change region, node type, or node count
# (optional) cat dev-eks-cluster-config.yaml
```

Create the cluster. This usually takes **10–15 minutes**:

```bash
eksctl create cluster -f dev-eks-cluster-config.yaml
```

eksctl will:

- Create a VPC and subnets
- Set up the EKS control plane
- Launch EC2 worker nodes
- Configure your `kubectl` context to use the new cluster
- Install common add-ons

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

Once `kubectl get nodes` shows nodes in `Ready` state, you can deploy CAIPE.

---

## Step 5: Deploy CAIPE on EKS

You have two main options:

### Option A: Install CAIPE with Helm

Install the CAIPE Helm chart directly on the cluster. Configure secrets and LLM settings as described in the Helm guide.

```bash
helm install ai-platform-engineering oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  --version 0.2.8 \
  --namespace ai-platform-engineering \
  --create-namespace \
  --set-string tags.basic=true
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

Open http://localhost:8080. Then deploy CAIPE via the Helm chart (as in Option A) or by defining an ArgoCD Application that points at the same chart (see [Helm setup – ArgoCD](/docs/getting-started/helm/setup#argocd)).

---

## Step 6 (Recommended): Install AWS Load Balancer Controller

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

### kubectl can’t reach the cluster

```bash
# Refresh kubeconfig for your cluster (use your region and cluster name)
aws eks update-kubeconfig --region us-east-2 --name dev-eks-cluster

# Confirm current context
kubectl config current-context
```

---

## Cleanup

When you’re done, delete the cluster to avoid ongoing AWS charges:

```bash
eksctl delete cluster -f dev-eks-cluster-config.yaml
```

Verify that CloudFormation stacks are gone:

```bash
aws cloudformation list-stacks --query 'StackSummaries[?contains(StackName, `eksctl-dev-cluster`)].{Name:StackName,Status:StackStatus}'
```

**Important:** Always tear down the cluster when you’re not using it to prevent unexpected charges.

---

## Next steps

- [Configure Agent Secrets](./configure-agent-secrets) — Secrets for GitHub, ArgoCD, and other agents
- [Configure LLMs](./configure-llms) — LLM provider and API keys for CAIPE
- [Deploy CAIPE with Helm](/docs/getting-started/helm/setup) — Chart options, tags, and values
- [Run with KinD](/docs/getting-started/kind/setup) — Local one-command setup without AWS
