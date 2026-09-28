/**
 * Backward-compatibility shim for the legacy `adminApi` flat-object.
 *
 * The implementation has been split into per-domain slices under
 * `./api/` as part of refactor P4.5 (admin/services per-domain split).
 * Existing imports like:
 *
 *   import { adminApi } from '@modules/admin/services/adminApi';
 *
 * continue to work unchanged — they resolve to the aggregate exported from
 * `./api/index.js`.
 *
 * New code SHOULD import the specific slice it needs, e.g.:
 *
 *   import { adminFinanceApi } from '@modules/admin/services/api/financeApi';
 */
export { adminApi } from './api';
export { default } from './api';
