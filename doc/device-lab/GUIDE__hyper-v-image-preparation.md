# Hyper-V image preparation boundaries

The image preparation application owns profile and cache selection, acquisition/import sequencing, deadlines and compensation. Native image-store composition supplies required synchronous path effects. Its existing exported `hyperVImageRoot`, `hyperVImageProfileRoot` and `hyperVOwnerImageProfileRoot` helpers remain the sole root layout authority for creation, manifest reading and cache inspection. Native `joinPath` retains platform-specific path joining; `resolvePath` retains absolute current-directory resolution. Neither effect may be replaced by an asynchronous function.

This internal contract change preserves the public image-store exports and all existing filenames, owner/global lookup order, preparation locks, licensing, manifest validation, identity fences and resource cleanup. It introduces no alternate layout configuration or public API.

The [imported image requirements](REQ__hyper-v-typed-image-preparation.md) and [automatic image requirements](REQ__hyper-v-typed-automatic-image-preparation.md) remain normative. The image-store, imported-transaction and automatic-transaction tests exercise those behaviors; Linux checks do not establish native Windows acquisition, mount or cleanup acceptance.
