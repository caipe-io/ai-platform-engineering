---
sidebar_position: 1
---

# Cluster Setup

CAIPE deploys on any Kubernetes 1.28+ cluster. Pick the option that fits your environment and proceed to [Deploy with Helm](./setup.md) once your cluster is ready.

---

## Option 1 — KinD (local, no cloud account needed)

KinD (Kubernetes in Docker) is the fastest way to get a cluster running locally for development or evaluation.

### Prerequisites

- Docker Desktop (or Docker Engine)
- [`kind`](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/)

### Create the cluster

```bash
kind create cluster --name caipe
kubectl cluster-info --context kind-caipe
```

Your cluster is ready. Jump to [Deploy with Helm →](./setup.md)

---

## Option 2 — AWS EKS

Use EKS for production or cloud-based evaluation.

### Install tools

| Tool | Purpose |
|------|---------|
| **AWS CLI** | Authenticate to AWS — [install](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| **eksctl** | Create and manage EKS clusters — [install](https://eksctl.io/installation/) |
| **kubectl** | Interact with the cluster — [install](https://kubernetes.io/docs/tasks/tools/) |

### Configure AWS credentials

```bash
aws configure
aws sts get-caller-identity
export AWS_DEFAULT_REGION=us-east-2
```

### Create the cluster

```bash
git clone https://github.com/caipe-io/ai-platform-engineering.git
cd ai-platform-engineering
cp deploy/eks/dev-eks-cluster-config.yaml.example dev-eks-cluster-config.yaml

# Takes ~10–15 minutes
eksctl create cluster -f dev-eks-cluster-config.yaml

# Verify nodes are ready
kubectl get nodes
```

### (Recommended) Install AWS Load Balancer Controller

Required for `LoadBalancer`-type services on EKS:

```bash
eksctl create iamserviceaccount \
  --cluster=dev-eks-cluster \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess \
  --approve

helm repo add eks https://aws.github.io/eks-charts && helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=dev-eks-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

Your cluster is ready. Jump to [Deploy with Helm →](./setup.md)

---

## Other cloud providers

The Helm install works on any conformant cluster. Follow your provider's managed Kubernetes guide:

| Provider | Managed Service |
|----------|----------------|
| Google Cloud | [GKE](https://cloud.google.com/kubernetes-engine/docs/quickstart) |
| Microsoft Azure | [AKS](https://learn.microsoft.com/en-us/azure/aks/quickstart-portal) |
| Self-managed | Any `kubeadm` or Rancher cluster |

Once `kubectl get nodes` shows your nodes in `Ready` state, proceed to [Deploy with Helm →](./setup.md)
