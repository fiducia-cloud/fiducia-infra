# `generated/` — not frozen

This directory is named `generated` but it is **not** a flags-2-env /
api-docs / interfaces freeze tree. Files here may stay writable. They are
not `chmod a-w` by policy.

Typical cases: compiler/tool caches, Flutter/Xcode `.generated/`, Gradle
`build/`, or scratch output that is not a source-of-truth adapter.
