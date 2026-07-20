/**
 * Re-export shim. The SBC distribution panel moved into the CDRs admin feature
 * folder during the glass refactor; this preserves the original import path used
 * by SippTab without forcing a change there.
 */
export { SbcDistribution } from './cdrs/components/SbcDistribution';
