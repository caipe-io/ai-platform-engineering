# MongoDB replica-set operation

Enable `replicaSet.enabled` when an application needs MongoDB's oplog, such as
for change data capture. The setting defaults to `false` and does not initialize
membership automatically.

## Set up

1. Create a keyfile with a random base64 key of 6–1024 characters and store it
   in a Kubernetes Secret under the `keyfile` key. Use the same Secret for all
   members. A Secret manager and ExternalSecret can provision it without putting
   the key in Helm values or source control.
2. Set `replicaSet.enabled: true`, `replicaSet.name`, and
   `replicaSet.keyFileSecretName` in the chart values. For multiple members, set
   `replicaCount` as well. Each member needs its own persistent volume.
3. Roll out the chart. It restarts an existing standalone MongoDB process on
   its current data volume. A one-member deployment is unavailable during that
   restart and until the set has a primary.
4. Connect to member 0 with an authenticated `mongosh` session and initialize
   the set once:

   ```javascript
   rs.initiate({
     _id: "rs0",
     members: [{ _id: 0, host: "mongodb-0.mongodb.example.svc.cluster.local:27017" }]
   })
   ```

   Use the configured replica-set name and a stable hostname reachable by
   clients and other members. If a migration service runs outside Kubernetes,
   it must also be able to reach the hostname advertised by the replica set.
   Add further members with `rs.add("member-hostname:27017")` after they start.
5. Check `rs.status()`, `db.hello()`, application reads and writes, and oplog
   retention before starting change capture.

The chart's default readiness probe checks process reachability. It does not
assert that membership has been initialized. Operators must complete step 4
before treating the service as writable. When `persistence.enabled: false`, a
pod replacement loses that member's data and replica-set configuration; a
single-member set then needs to be initialized again.

## Rotate the keyfile

MongoDB accepts a YAML sequence of keys. To rotate without breaking
multi-member authentication, put both the old and new key in the Secret, wait
for the Secret to update, and restart secondaries one at a time, then the
primary. After every member accepts the new key, update the Secret to contain
only the new key and repeat the rolling restarts. Members must share at least
one key throughout. A one-member set has a brief interruption on each restart.
See [MongoDB's key rotation procedure](https://www.mongodb.com/docs/manual/tutorial/rotate-key-replica-set/).
