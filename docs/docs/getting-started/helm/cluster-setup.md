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

Use the [EKS Auto Mode setup guide](../eks/setup.md). It covers the required
cluster configuration, storage class, and RAG NodePool before Helm deployment.
Auto Mode includes load balancing, so its setup does not require a separate
AWS Load Balancer Controller install.

---

## Other cloud providers

The Helm install works on any conformant cluster. Follow your provider's managed Kubernetes guide:

| Provider | Managed Service |
|----------|----------------|
| Google Cloud | [GKE](https://cloud.google.com/kubernetes-engine/docs/quickstart) |
| Microsoft Azure | [AKS](https://learn.microsoft.com/en-us/azure/aks/quickstart-portal) |
| Self-managed | Any `kubeadm` or Rancher cluster |

Once `kubectl get nodes` shows your nodes in `Ready` state, proceed to [Deploy with Helm →](./setup.md)
