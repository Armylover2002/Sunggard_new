/**
 * Aggregate barrel that reassembles the original `adminApi` shape from the
 * per-domain slices introduced in refactor P4.5.
 *
 * Consumers who only need one slice (e.g. finance) should prefer importing
 * directly:
 *
 *   import { adminFinanceApi } from '../services/api/financeApi';
 *
 * Consumers who relied on the original `import { adminApi } from
 * '../services/adminApi'` continue to work unchanged — the legacy entry-point
 * at `../adminApi.js` re-exports the aggregate from here.
 */

import { adminAuthApi } from './authApi';
import { adminSettingsApi } from './settingsApi';
import { adminFinanceApi } from './financeApi';
import { adminSupportApi } from './supportApi';
import { adminDeliveryApi } from './deliveryApi';
import { adminContentApi } from './contentApi';
import { adminPorterApi } from './porterApi';

export {
    adminAuthApi,
    adminSettingsApi,
    adminFinanceApi,
    adminSupportApi,
    adminDeliveryApi,
    adminContentApi,
    adminPorterApi,
};

/**
 * Aggregate `adminApi` matching the original flat-object shape. Preserves
 * every existing call-site like `adminApi.getStats(...)`.
 */
export const adminApi = {
    ...adminAuthApi,
    ...adminSettingsApi,
    ...adminFinanceApi,
    ...adminSupportApi,
    ...adminDeliveryApi,
    ...adminContentApi,
    ...adminPorterApi,
};

export default adminApi;
