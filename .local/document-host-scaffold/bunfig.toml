# Hoisted linker: the default "isolated" linker does not hoist deps to the root
# node_modules, which breaks Dockerfiles that copy only the root node_modules and
# confuses Metro / expo-doctor. Keep this in sync with any Dockerfile copy of it.
[install]
linker = "hoisted"
