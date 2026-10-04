# Production graph and ARM followup

The first exact-source ARM run 37211720714/caff995c8 built its production image and passed the physical Forge-absence/native-package-byte inventory. The following public API test failed because it attempted to resolve an API **devDependency** alias deliberately omitted by production. No ARM acceptance is attributed to that failed run. Full authenticated logs remain at the external evidence path/hash in this proof.

The updated image test obtains the exact native adapter root from the successful actual-image byte inventory, requires every admitted package root below `/app/`, and executes that physical adapter. It does not overlay the application or add an alias. Installed files must be regular files, rejecting a symlink into the mounted proof. Host checks still use normal API resolution by default.

The production-closure fixture initially failed because its historical assertion required materialized Forge. It now reproduces the actual frozen production flags and exact file-dependency inputs, requires zero Forge copies, checks both native packages against every archive file, and exercises the physically installed native API. Database peers still must resolve and load from that isolated production graph. The fixture never claims that an omitted devDependency resolves from the production API. It passes with 14 public API checks; six inventory controls include a symlink-substitution negative.

The new exact-source ARM run and independent acceptance remain pending. Failed image checks preserve successfully built OCI evidence for diagnosis; uploading evidence does not make a failed run accepted.
