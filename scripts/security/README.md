# Scan release images

Release image findings belong to the release tag whose images were scanned.
Filesystem findings belong to the source revision being scanned.

The release finalizer dispatches `security-scan.yml` after publishing a stable
release and after its required image builds pass. Existing releases and release
candidates can be scanned once their image builds finish:

```sh
gh workflow run security-scan.yml --repo OWNER/REPOSITORY --ref main -f tag=VERSION
```

A full stable release is not required to validate candidate images. Build a new
candidate after merging security changes, then scan its exact tag. Preserve
existing release tags and image artifacts.

A successful workflow means the scan and upload completed. Check the findings
on the scanned tag before claiming an image is free of vulnerabilities.
