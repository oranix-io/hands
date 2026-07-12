-- Productize crash symbolication (#136): promote the symbolicated stack from an
-- async internal comment to first-class, queryable fields on the crash ticket.
--   symbolication_status: null (not yet run) | pending | symbolicated |
--     no_symbols (missing symbol asset — operator-actionable) | unsymbolicated
--     (container returned nothing) | failed | not_applicable (no native frames).
--   symbolicated_stack: the resolved stack text when symbolicated, or the
--     operator-actionable guidance when no_symbols.
--   symbolicated_at: epoch ms of the last symbolication run.
-- This lets the detail panel render the stack directly and a one-click re-run
-- endpoint recompute it, instead of scanning synthetic comments.
ALTER TABLE feedback_tickets ADD COLUMN symbolication_status TEXT;
ALTER TABLE feedback_tickets ADD COLUMN symbolicated_stack TEXT;
ALTER TABLE feedback_tickets ADD COLUMN symbolicated_at INTEGER;
