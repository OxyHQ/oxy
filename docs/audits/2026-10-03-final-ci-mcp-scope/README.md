# Preserve MCP coverage after issuer rebase

CI37117556034 completed all functional jobs successfully, but Guards still failed Scope and Forge. The scope fixture correctly found that the issuer-based workflow omitted the previously reviewed MCP platform test step. Restore exactly that step from b4c4ae, keeping the two failing expectations unchanged. Scope39 and the actual MCP9/49 suite pass locally.

The inactive Forge decision now uses the closed canonical schema (null claims). This removes a malformed inactive record; it does not activate policy or excuse Forge. Retained authorization/history and the fixed9October22UTC expiry apply to the later final-image validation. [proof.json](proof.json) distinguishes the failed prior CI and new local checks.
