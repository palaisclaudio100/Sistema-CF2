# Ordinary executor scope — P0 final

This phase starts at 8dac535. Transport, canon gateway, identities and existing ACL are reused. No new actor or endpoint is introduced.

Diego dispatches ORDINARY_WORK through start_workflow. Its payload contains a concrete brief, source_reference and one scoped step per actor. Gaby Chat can ANALYZE_DRAFT_VALIDATE, Gaby CW can WRITE_VALIDATED or run registered audiovisual tooling, Codex can TECHNICAL_RUN, and Claude Code can AUXILIARY_REVIEW only upon Diego assignment. All ordinary dispatches are checked server-side, including single-actor requests. Claude Code is a one-shot native process; polling belongs to the generic transport supervisor, not a resident Claude model or system-pass loop.

Gaby Chat has native public web search, authenticated canon reads and explicitly registered input objects, with shell/file mutation tools disabled. It produces actual complete documentary content and a validation decision. Gaby CW receives that content from an authentic server-stored Chat RESPONSE; client claims of validation are insufficient. The exact destination, original version and active lease are checked before and after writing. No model-controlled path, executable or command arguments are accepted.

The installed local object/command registry is outside the repository and protected with user DPAPI. Document objects are writable only by Gaby CW. Canon objects additionally require explicit enablement and a validated PATCH with unique original anchors; whole-file replacement is forbidden. Codex runs exact registered technical commands with pinned script hashes and reads authorized evidence. Claude Code receives authorized inputs and returns an auxiliary report, never a final VERIFICATION or a system pass.

The writer uses a before-image, per-object lock, prepared/committed receipt, atomic replacement, mandatory read-back and request-keyed replay detection. Version conflicts fail closed. Loss of the live authorization after replacement rolls back only if the file still equals this write. Two read-back failures lock the object until engineering resolves the defect. No actor gains authority by possessing a tool.

Acceptance uses a useful operational guide in the existing communication folder: native Gaby Chat analysis/drafting, controlled Gaby CW material write, independent native Codex analysis plus a real registered document-check command, and a native auxiliary Claude review. The final workflow updates the same guide with before/after hashes and a preserved backup; it is not a synthetic connectivity exchange.

Resource access to a new object requires an explicit engineering registry entry and a Diego-scoped job. An unsupported or unavailable audiovisual binary is a declared executor capability defect, never a request for Claudio to transport files. Canonical content, credentials, installation paths and test artifacts are not committed to the public repository.
