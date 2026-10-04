# Scoped pilot price binding

A new scoped route previously received a random Oxy price ID, so the signed exact audience could not match its first import. A private import now requires the exact source-reviewed audience before creating its declared price identity. Existing IDs, prices and foreign routes cannot be renamed or repriced by that import. The deployment remains disabled/pending review. Ordinary imports retain their existing behavior.

The internal pilot can measure the complete controlled decisions input only for an already authenticated exact permit and fixture. It admits only that permit’s exact route, preserving existing input, concurrency, daily and quote limits. The source permit remains absent. No API flag or remote metadata creates authority.

Validation: canonical API package Jest against fresh owned PostgreSQL17, 46 tests/3 suites; API build and scoped ESLint with zero warnings. Own database stopped. The first run’s decimal-scale assertion failure is retained and fixed by decimal normalization; it is not labelled a failing baseline. The source remains based on the receipt/clock branch, to be composed with current main and permanent Forge removal before promotion.
