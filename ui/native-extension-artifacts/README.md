This directory is empty in the standard CAIPE image. Derived images may place
reviewed, immutable native-extension `.tgz` artifacts here and install them
with an exact `file:native-extension-artifacts/<name>.tgz` dependency. The
Docker dependency stage copies this directory before `npm ci` so lockfile
integrity is verified during the build. Do not commit private package artifacts
to the CAIPE source repository.
