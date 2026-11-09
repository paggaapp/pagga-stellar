/** Lazy loader for the Stellar SDK-backed module, so pages don't pay for it up front (and tests can mock one import). */
export const loadDefindex = () => import('./defindex');
