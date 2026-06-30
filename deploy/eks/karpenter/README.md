# NodePool Configuration

This manifest configures a custom RAG node tier on top of an EKS Auto Mode cluster. Auto Mode runs Karpenter as a managed service and provides a `default` NodeClass automatically, no separate Karpenter install is required.

Only the memory-bound RAG stack gets a dedicated pool. The Dynamic Agents runtime, the `mcp-*` tool servers, and the platform services stay on the Auto Mode `general-purpose` pool, which already bin-packs and consolidates them, so they need no taint or per-workload scheduling config.

## Workload tiers

| NodePool | Taint | Workloads | Instance strategy |
|----------|-------|-----------|-------------------|
| `rag` | `workload-type=rag:NoSchedule` | `rag-server`, `agent-ontology`, `rag-redis`, `neo4j`, `milvus` | On-demand, memory-optimised (`r5`/`r6i`) |
| `general-purpose` *(built-in)* | *(none)* | `dynamic-agents`, `mcp-*`, `caipe-ui`, `keycloak`, `openfga`, `slack-bot`, … | Auto Mode managed |

The `milvus` vector backend pulls in its own `etcd` and `minio` StatefulSets, which are pinned to the `rag` pool too. Workloads without the `workload-type=rag` toleration land on the Auto Mode `general-purpose` pool. The values overlay (`charts/ai-platform-engineering/values-karpenter.yaml`) applies the RAG nodeSelector/toleration and enables PodDisruptionBudgets on the general-purpose workloads so consolidation doesn't take them fully offline.

## Prerequisites

- EKS cluster created with `autoModeConfig: enabled: true` (see `deploy/eks/dev-eks-cluster-config.yaml.example`)
- `kubectl` configured to talk to the cluster

## Apply

```bash
kubectl apply -f deploy/eks/karpenter/
```

Verify the NodePool is created and the built-in Auto Mode pools are present:

```bash
kubectl get nodepool
```

You should see `rag` alongside the built-in `general-purpose` and `system` pools. The `rag` pool should show `READY=True` even at zero nodes. Confirm its status conditions:

```bash
kubectl get nodepool rag -o jsonpath='{.status.conditions}' | jq .
```

The `rag` pool will show no nodes until RAG workloads are scheduled.

Then deploy the platform with the Karpenter values overlay:

```bash
helm upgrade --install ai-platform-engineering \
  oci://ghcr.io/cnoe-io/charts/ai-platform-engineering \
  -f charts/ai-platform-engineering/values.yaml \
  -f charts/ai-platform-engineering/values-karpenter.yaml
```

## Multi-tenancy note

The `workload-type` taint is a **single-tenant design**. Taints and tolerations control which tier a pod lands on, but do not prevent pods from different tenants sharing the same node within a tier. If tenant isolation is required (for example, regulated environments or contractual data separation), extend the taint scheme with a second tenant dimension:

```yaml
taints:
  - key: workload-type
    value: rag
    effect: NoSchedule
  - key: tenant
    value: acme
    effect: NoSchedule
```

This increases node count (bin-packing across tenants is no longer possible) and requires one NodePool per tenant per tier. The RAG tier warrants the most attention: neo4j holds ingested knowledge, so node-level isolation is the infrastructure precondition for data separation between tenants.

## Testing

### Verify nodes

```bash
# List nodes provisioned by the rag NodePool (after rag-stack is deployed)
kubectl get nodes -l karpenter.sh/nodepool=rag

# Show instance type, NodePool, and capacity type for all nodes
kubectl get nodes -o custom-columns="NAME:.metadata.name,INSTANCE-TYPE:.metadata.labels.node\.kubernetes\.io/instance-type,NODEPOOL:.metadata.labels.karpenter\.sh/nodepool,CAPACITY:.metadata.labels.karpenter\.sh/capacity-type"
```

### Test consolidation (scale-in)

Scale the RAG workloads down (or disable optional backends) and watch Karpenter consolidate under-utilised `rag` nodes within ~60 seconds:

```bash
kubectl get nodes -l karpenter.sh/nodepool=rag -w
kubectl get nodeclaim -w
```

## Troubleshooting

### NodePool not showing READY=True

A healthy NodePool shows `READY=True` even at zero nodes. An empty READY column means Karpenter has rejected the NodePool spec, this is most commonly due to a bad `nodeClassRef` being used.

EKS Auto Mode uses its own `NodeClass` API, rather than the standalone Karpenter `EC2NodeClass`. Ensure the `nodeClassRef` in the NodePool is:

```yaml
nodeClassRef:
  group: eks.amazonaws.com
  kind: NodeClass
  name: default
```

Similarly, the instance selector keys must use the `eks.amazonaws.com` prefix, and not `karpenter.k8s.aws/instance-family`:

```yaml
- key: eks.amazonaws.com/instance-category
  operator: In
  values: ["r"]
- key: eks.amazonaws.com/instance-generation
  operator: Gt
  values: ["4"]
```

Inspect the failure reason directly with `kubectl get nodepool rag -o jsonpath='{.status.conditions}' | jq .`
