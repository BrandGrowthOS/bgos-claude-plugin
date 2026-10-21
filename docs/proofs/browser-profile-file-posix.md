# Actual Linux file foundation check

The probe runs the committed file area, artifact and staging modules in the immutable ec984a6 image as Linux uid1000 with network disabled. It uses real filesystem operations. The attached JSON records image identity, exact script hash and the results. The helper is retained under test/probes for review; its absolute import path deliberately targets this proof image.

The run proves directory mode0700, materialized file mode0600, refusal of existing permissive directories without changing their modes, refusal of symlinks and hardlinks, detection of an original directory replaced by another inode, one-use opaque artifact handles, zeroing of borrowed plaintext and removal of materialized files. Both file helpers drain successfully and the private area is empty. Docker records exit0, PID0 and no OOM. Normal removal is followed by an explicit no-such-container result, with no forced stop.

This is a filesystem foundation check. The callback writes synthetic bytes instead of invoking a browser engine. It does not prove signed Companion integration, permissioned HOAI file forwarding or actual browser upload/download. Those remain separate composed checks. The foundation's executable mutation tests are recorded in browser-profile-agent-files-mutations.json.

The first two fixture launches did not execute the probe because the Snap Docker client could not see the SSH host's temporary directory. The passing run copies the same script from a private home directory into the owned disposable container, then starts it. These fixture failures and a pre-execution API correction are excluded from passing evidence. Installed agent software and production records were untouched.
