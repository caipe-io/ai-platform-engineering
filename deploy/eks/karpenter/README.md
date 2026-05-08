# NodePool Configuration

These manifests configure custom node tiers on top of an EKS Auto Mode cluster. Auto Mode runs Karpenter as a managed service and provides a `default` NodeClass automatically, no separate Karpenter install is required.

## Workload tiers

| NodePool | Taint | Workloads | Instance strategy |
|----------|-------|-----------|-------------------|
| `agents` | `workload-type=agent:NoSchedule` | All `agent-*` subcharts | Spot-preferred, compute-optimised (`c5`/`m5`/`m6i`) |
| `rag` | `workload-type=rag:NoSchedule` | `rag-server`, `agent-ontology`, `neo4j`, `milvus` | On-demand, memory-optimised (`r5`/`r6i`) |
| `general-purpose` *(built-in)* | *(none)* | `supervisor-agent`, `caipe-ui`, `langgraph-redis`, `slack-bot` | Auto Mode managed |

Workloads not matching a custom NodePool taint land on the Auto Mode `general-purpose` pool.

## Prerequisites

- EKS cluster created with `autoModeConfig: enabled: true` (see `deploy/eks/cluster-config.yaml.example`)
- `kubectl` configured to talk to the cluster

## Apply

```bash
kubectl apply -f deploy/eks/karpenter/
```

Verify the NodePools are created and the built-in Auto Mode pools are present:

```bash
kubectl get nodepool
```

You should see `agents` and `rag` alongside the built-in `general-purpose` and `system` pools. Both custom pools should show `READY=True` even at zero nodes. Confirm their status conditions:

```bash
kubectl get nodepool agents -o jsonpath='{.status.conditions}' | jq .
kubectl get nodepool rag -o jsonpath='{.status.conditions}' | jq .
```

The custom pools will show no nodes until workloads are scheduled.

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
    value: agent
    effect: NoSchedule
  - key: tenant
    value: acme
    effect: NoSchedule
```

This increases node count (bin-packing across tenants is no longer possible) and requires one NodePool per tenant per tier. The RAG tier warrants the most attention: neo4j and Milvus hold ingested knowledge, so node-level isolation is the infrastructure precondition for data separation between tenants.

## Testing

### Verify nodes

```bash
# List nodes provisioned by each custom NodePool
kubectl get nodes -l karpenter.sh/nodepool=agents
kubectl get nodes -l karpenter.sh/nodepool=rag

# Show instance type, NodePool, and capacity type for all nodes
kubectl get nodes -o custom-columns="NAME:.metadata.name,INSTANCE-TYPE:.metadata.labels.node\.kubernetes\.io/instance-type,NODEPOOL:.metadata.labels.karpenter\.sh/nodepool,CAPACITY:.metadata.labels.karpenter\.sh/capacity-type"
```

### Trigger HPA to scale-out

```bash
# Generate CPU load on an agent pod
kubectl exec -it <agent-pod> -- sh -c "timeout 120 yes > /dev/null"

# Watch HPA scale replicas
kubectl get hpa -w

# Watch Karpenter provision new nodes
kubectl get nodeclaim -w
```

### Test consolidation (scale-in)

Remove load and wait for HPA to scale replicas down. Karpenter will consolidate under-utilised nodes within ~30 seconds for the `agents` pool and ~60 seconds for `rag`.

```bash
kubectl get nodes -l karpenter.sh/nodepool=agents -w
```

## Troubleshooting

### NodePool not showing READY=True

A healthy NodePool shows `READY=True` even at zero nodes. An empty READY column means Karpenter has rejected the NodePool spec, this is most commonly due to a bad `nodeClassRef` being used.

EKS Auto Mode uses its own `NodeClass` API, rather than the standalone Karpenter `EC2NodeClass`. Ensure the `nodeClassRef` in each NodePool is:

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
  values: ["c", "m"]
- key: eks.amazonaws.com/instance-generation
  operator: Gt
  values: ["4"]
```

Inspect the failure reason directly with `kubectl get nodepool agents -o jsonpath='{.status.conditions}' | jq .`

### Test spot interruption (agents NodePool)

```bash
kubectl cordon <karpenter-spot-node>
kubectl drain <karpenter-spot-node> --ignore-daemonsets --delete-emptydir-data
# Karpenter automatically replaces the node
```
